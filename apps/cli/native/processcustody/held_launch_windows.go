//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	createBreakawayFromJob    = 0x01000000
	detachedProcess           = 0x00000008
	createNewProcessGroup     = 0x00000200
	jobObjectLimitBreakawayOk = 0x00000800
)

// heldLaunch starts a Session holder that outlives its runner, as on Linux and macOS. The holder
// breaks away from the runner's owner Job (whose cleanup terminates that Job) and is placed in a
// new kill-on-close Job whose only handle the holder itself owns: the holder's Agent tree ends
// with the holder, never with the runner or the daemon. The holder inherits this helper's stdio,
// environment and working directory; this helper writes nothing to stdout and exits once the
// holder runs, so the caller reads the holder's own readiness line.
func heldLaunch(args []string) error {
	verbatim := false
	target := []string(nil)
	for index, arg := range args {
		if arg == "--" {
			target = args[index+1:]
			break
		}
		if arg == "--windows-verbatim" {
			verbatim = true
			continue
		}
		return fmt.Errorf("held-launch: unknown option %q", arg)
	}
	if len(target) == 0 {
		return fmt.Errorf("held-launch requires -- <command> [args...]")
	}
	job, _, callErr := procCreateJobObjectW.Call(0, 0)
	if job == 0 {
		return fmt.Errorf("CreateJobObjectW failed: %v", callErr)
	}
	defer procCloseHandle.Call(job)
	limits := jobObjectExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	if result, _, callErr := procSetInformationJobObject.Call(job, jobObjectExtendedLimitInfoClass,
		uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); result == 0 {
		return fmt.Errorf("SetInformationJobObject failed: %v", callErr)
	}
	si := startupInfoW{Cb: uint32(unsafe.Sizeof(startupInfoW{}))}
	si.DwFlags = startfUseStdHandles
	for index, pseudoHandle := range []uintptr{stdInputHandle, stdOutputHandle, stdErrorHandle} {
		handle, _, callErr := procGetStdHandle.Call(pseudoHandle)
		if handle == invalidHandleValue {
			return fmt.Errorf("GetStdHandle failed: %v", callErr)
		}
		switch index {
		case 0:
			si.HStdInput = handle
		case 1:
			si.HStdOutput = handle
		case 2:
			si.HStdError = handle
		}
	}
	// The holder's stderr is NUL, as for any held process: the caller's stderr is this helper's
	// diagnostics channel and closes when the caller stops reading it.
	nulName, err := syscall.UTF16PtrFromString("NUL")
	if err != nil {
		return err
	}
	nul, err := windows.CreateFile(nulName, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		&windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1},
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return fmt.Errorf("open NUL: %v", err)
	}
	defer windows.CloseHandle(nul)
	si.HStdError = uintptr(nul)
	commandLine, err := syscall.UTF16PtrFromString(windowsCommandLine(target, verbatim))
	if err != nil {
		return err
	}
	var pi processInformation
	create := func(flags uintptr) (uintptr, error) {
		result, _, callErr := procCreateProcessW.Call(0, uintptr(unsafe.Pointer(commandLine)), 0, 0,
			1, // inherit handles: the holder receives the caller's exact stdio
			createSuspended|detachedProcess|createNewProcessGroup|flags,
			0, 0, uintptr(unsafe.Pointer(&si)), uintptr(unsafe.Pointer(&pi)))
		return result, callErr
	}
	if result, callErr := create(createBreakawayFromJob); result == 0 {
		if errnoOf(callErr) != syscall.ERROR_ACCESS_DENIED {
			return fmt.Errorf("CreateProcessW failed: %v", callErr)
		}
		// The innermost enclosing Job forbids breakaway (no runner owner Job, e.g. a CI or
		// launcher Job): the holder still runs and owns its Agent tree, but stays in that Job,
		// so it ends with it. Reported on stderr for the caller to log.
		if result, callErr := create(0); result == 0 {
			return fmt.Errorf("CreateProcessW failed: %v", callErr)
		}
		fmt.Fprintln(os.Stderr, "held-launch: an enclosing Job forbids breakaway; the holder stays in it and ends with it")
	}
	defer procCloseHandle.Call(pi.HThread)
	defer procCloseHandle.Call(pi.HProcess)
	fail := func(format string, values ...any) error {
		procTerminateProcess.Call(pi.HProcess, 1)
		return fmt.Errorf(format, values...)
	}
	if result, _, callErr := procAssignProcessToJobObject.Call(job, pi.HProcess); result == 0 {
		return fail("AssignProcessToJobObject failed: %v", callErr)
	}
	// The holder owns its Job: the Job (and so the Agent tree) lives exactly as long as the holder.
	var owned windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(job), windows.Handle(pi.HProcess), &owned,
		0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return fail("DuplicateHandle (Job into holder) failed: %v", err)
	}
	if result, _, callErr := procResumeThread.Call(pi.HThread); result == waitFailed {
		return fail("ResumeThread failed: %v", callErr)
	}
	return nil
}
