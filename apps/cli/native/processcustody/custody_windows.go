//go:build windows

// Windows Job Object custody. The one SVC09-owned containment primitive:
// the target is created suspended, assigned to a generation-unique named job
// before its primary thread runs, and only then resumed. Because the helper is
// the direct child of the host, stdin/stdout/stderr handles and the exact
// environment are inherited by the target untouched — there is no relay and no
// re-encoding anywhere on the path.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                          = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW              = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject       = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject      = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject            = kernel32.NewProc("TerminateJobObject")
	procQueryInformationJobObject     = kernel32.NewProc("QueryInformationJobObject")
	procOpenJobObjectW                = kernel32.NewProc("OpenJobObjectW")
	procCreateProcessW                = kernel32.NewProc("CreateProcessW")
	procResumeThread                  = kernel32.NewProc("ResumeThread")
	procWaitForSingleObject           = kernel32.NewProc("WaitForSingleObject")
	procGetExitCodeProcess            = kernel32.NewProc("GetExitCodeProcess")
	procTerminateProcess              = kernel32.NewProc("TerminateProcess")
	procCloseHandle                   = kernel32.NewProc("CloseHandle")
	procGetStdHandle                  = kernel32.NewProc("GetStdHandle")
)

const (
	createSuspended                   = 0x00000004
	startfUseStdHandles               = 0x00000100
	jobObjectLimitKillOnJobClose      = 0x00002000
	jobObjectExtendedLimitInformation = 9
	jobObjectBasicProcessIdList       = 3
	jobObjectTerminate                = 0x0008
	jobObjectQuery                    = 0x0004
	// (DWORD)-10/-11/-12: the Win32 STD_*_HANDLE pseudo-handle numbers.
	stdInputHandle  = ^uintptr(9)  // -10
	stdOutputHandle = ^uintptr(10) // -11
	stdErrorHandle  = ^uintptr(11) // -12
	errorAlreadyExists = syscall.Errno(183)
	errorFileNotFound  = syscall.Errno(2)
	errorMoreData      = syscall.Errno(234)
	waitInfinite       = 0xFFFFFFFF
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type startupInfoW struct {
	Cb              uint32
	LpReserved      *uint16
	LpDesktop       *uint16
	LpTitle         *uint16
	DwX             uint32
	DwY             uint32
	DwXSize         uint32
	DwYSize         uint32
	DwXCountChars   uint32
	DwYFillChars    uint32
	DwFillAttribute uint32
	DwFlags         uint32
	WShowWindow     uint16
	CbReserved2     uint16
	LpReserved2     *byte
	HStdInput       uintptr
	HStdOutput      uintptr
	HStdError       uintptr
}

type processInformation struct {
	HProcess    uintptr
	HThread     uintptr
	DwProcessId uint32
	DwThreadId  uint32
}

// callOK reports whether a LazyProc.Call returned success. LazyProc.Call always
// yields a non-nil `lastErr` interface carrying the raw errno, including
// Errno(0) on success, so both nil and Errno(0) mean success.
func callOK(callErr error) bool {
	return callErr == nil || callErr == syscall.Errno(0)
}

// errnoOf extracts the raw errno from a LazyProc.Call error. A nil error is
// Errno(0) for this purpose.
func errnoOf(callErr error) syscall.Errno {
	if callErr == nil {
		return 0
	}
	if errno, ok := callErr.(syscall.Errno); ok {
		return errno
	}
	return 0
}

// quoteWindowsArgument renders one argument with the MSVCRT command-line rule
// so the target's argv decoding recovers the exact original string. The host
// passes target arguments through its own argv, which already decoded the
// caller's command line losslessly; this is the lossless inverse.
func quoteWindowsArgument(value string) string {
	if value == "" {
		return `""`
	}
	needsQuoting := strings.ContainsAny(value, " \t\n\v\"")
	var builder strings.Builder
	if needsQuoting {
		builder.WriteByte('"')
	}
	backslashes := 0
	for _, char := range value {
		switch char {
		case '\\':
			backslashes++
			builder.WriteByte('\\')
		case '"':
			builder.WriteString(strings.Repeat(`\`, backslashes*2+1))
			builder.WriteByte('"')
			backslashes = 0
		default:
			builder.WriteString(strings.Repeat(`\`, backslashes))
			backslashes = 0
			builder.WriteRune(char)
		}
	}
	if needsQuoting {
		builder.WriteString(strings.Repeat(`\`, backslashes*2))
		builder.WriteByte('"')
	}
	return builder.String()
}

func windowsCommandLine(target []string) string {
	parts := make([]string, 0, len(target))
	for _, arg := range target {
		parts = append(parts, quoteWindowsArgument(arg))
	}
	return strings.Join(parts, " ")
}

// writeHandshakeFile publishes the custody fact only after assignment: the
// file's existence is the single "job assigned and target resumed" marker the
// host polls for. A write-then-rename keeps a partial file from ever being
// observed as established custody.
func writeHandshakeFile(path string, pid int, job string) error {
	handshake, err := json.Marshal(map[string]any{"v": 1, "pid": pid, "job": job})
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(handshake, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func parseRunArgs(args []string) (job string, handshakePath string, target []string, err error) {
	parsingOptions := true
	for _, arg := range args {
		if parsingOptions && strings.HasPrefix(arg, "--job=") {
			job = strings.TrimPrefix(arg, "--job=")
			continue
		}
		if parsingOptions && strings.HasPrefix(arg, "--handshake=") {
			handshakePath = strings.TrimPrefix(arg, "--handshake=")
			continue
		}
		if parsingOptions && arg == "--" {
			parsingOptions = false
			continue
		}
		if parsingOptions {
			return "", "", nil, fmt.Errorf("run requires --job=<name> before --")
		}
		target = append(target, arg)
	}
	if job == "" || len(target) == 0 {
		return "", "", nil, fmt.Errorf("run requires --job=<name> and a target command after --")
	}
	return job, handshakePath, target, nil
}

func runCustodyCommand(args []string) error {
	job, handshakePath, target, err := parseRunArgs(args)
	if err != nil {
		usage()
		os.Exit(exitUsage)
	}
	jobNamePtr, err := syscall.UTF16PtrFromString(job)
	if err != nil {
		return err
	}

	jobHandle, _, callErr := procCreateJobObjectW.Call(0, uintptr(unsafe.Pointer(jobNamePtr)))
	if jobHandle == 0 {
		return fmt.Errorf("CreateJobObjectW failed: %v", callErr)
	}
	defer procCloseHandle.Call(jobHandle)
	if errnoOf(callErr) == errorAlreadyExists {
		// A reused name means this custody is not generation-unique. Fail
		// closed rather than sharing a containment with an unknown sibling.
		fmt.Fprintln(os.Stderr, "job name already exists; custody is not generation-unique")
		os.Exit(exitNotEstablished)
	}

	limits := jobObjectExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	if _, _, callErr := procSetInformationJobObject.Call(
		jobHandle,
		jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		unsafe.Sizeof(limits),
	); !callOK(callErr) {
		return fmt.Errorf("SetInformationJobObject failed: %v", callErr)
	}

	commandLinePtr, err := syscall.UTF16PtrFromString(windowsCommandLine(target))
	if err != nil {
		return err
	}
	si := startupInfoW{Cb: uint32(unsafe.Sizeof(startupInfoW{}))}
	si.DwFlags = startfUseStdHandles
	for index, pseudoHandle := range []uintptr{stdInputHandle, stdOutputHandle, stdErrorHandle} {
		handle, _, callErr := procGetStdHandle.Call(pseudoHandle)
		if !callOK(callErr) {
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
	var pi processInformation
	if _, _, callErr := procCreateProcessW.Call(
		0,
		uintptr(unsafe.Pointer(commandLinePtr)),
		0,
		0,
		1, // inherit handles: the target receives the caller's exact stdio
		createSuspended,
		0, // inherit the helper environment: the caller's exact env
		0, // inherit the helper working directory: the caller's exact cwd
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	); !callOK(callErr) {
		return fmt.Errorf("CreateProcessW failed: %v", callErr)
	}
	defer procCloseHandle.Call(pi.HThread)
	defer procCloseHandle.Call(pi.HProcess)

	// Assignment happens while the target is suspended: not one target
	// instruction can run outside the job. On failure the suspended target is
	// destroyed here, so no uncontained process can outlive this failure and
	// no handshake is ever published.
	if _, _, callErr := procAssignProcessToJobObject.Call(jobHandle, pi.HProcess); !callOK(callErr) {
		procTerminateProcess.Call(pi.HProcess, 1)
		fmt.Fprintf(os.Stderr, "AssignProcessToJobObject failed: %v; suspended target destroyed\n", callErr)
		os.Exit(exitNotEstablished)
	}

	if handshakePath != "" {
		if err := writeHandshakeFile(handshakePath, int(pi.DwProcessId), job); err != nil {
			fmt.Fprintf(os.Stderr, "handshake write failed: %v\n", err)
			os.Exit(exitNotEstablished)
		}
	}

	if _, _, callErr := procResumeThread.Call(pi.HThread); !callOK(callErr) {
		// The target is assigned but could not be started. Terminate the job:
		// the suspended root dies and KILL_ON_JOB_CLOSE reaps every member.
		procTerminateJobObject.Call(jobHandle, 1)
		return fmt.Errorf("ResumeThread failed: %v", callErr)
	}

	if _, _, callErr := procWaitForSingleObject.Call(pi.HProcess, waitInfinite); !callOK(callErr) {
		return fmt.Errorf("WaitForSingleObject failed: %v", callErr)
	}
	var exitCode uint32
	if _, _, callErr := procGetExitCodeProcess.Call(pi.HProcess, uintptr(unsafe.Pointer(&exitCode))); !callOK(callErr) {
		return fmt.Errorf("GetExitCodeProcess failed: %v", callErr)
	}
	// Closing the last job handle here is containment enforcement, not
	// cleanup: KILL_ON_JOB_CLOSE terminates every member that outlived the
	// root, so descendants cannot escape through this process exiting.
	procCloseHandle.Call(jobHandle)
	os.Exit(int(exitCode))
	return nil
}

// openJobByName opens a named job with the requested access. The boolean result
// distinguishes "absent" (the caller's proof of destruction) from a real failure.
func openJobByName(name string, access uint32) (uintptr, bool, error) {
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, false, err
	}
	handle, _, callErr := procOpenJobObjectW.Call(
		uintptr(access),
		0,
		uintptr(unsafe.Pointer(namePtr)),
	)
	if handle == 0 {
		if errnoOf(callErr) == errorFileNotFound {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("OpenJobObjectW failed: %v", callErr)
	}
	return handle, true, nil
}

// jobMemberCount proves membership absence with the kernel's own member list:
// a zero count is the "full membership absence" fact, not a heuristic.
func jobMemberCount(jobHandle uintptr) (int, error) {
	buffer := make([]byte, 64*1024)
	var returnLength uint32
	_, _, callErr := procQueryInformationJobObject.Call(
		jobHandle,
		jobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
		uintptr(unsafe.Pointer(&returnLength)),
	)
	if !callOK(callErr) {
		if errnoOf(callErr) == errorMoreData {
			// More members than the bounded buffer can hold: report a
			// fail-closed non-zero count instead of a guess.
			return 1 << 30, nil
		}
		return 0, fmt.Errorf("QueryInformationJobObject failed: %v", callErr)
	}
	if returnLength < 8 {
		return 0, fmt.Errorf("QueryInformationJobObject returned a truncated member list")
	}
	count := *(*uint32)(unsafe.Pointer(&buffer[4]))
	return int(count), nil
}

func parseJobArgs(args []string) (job string, timeoutMs int, err error) {
	timeoutMs = 5000
	for _, arg := range args {
		switch {
		case strings.HasPrefix(arg, "--job="):
			job = strings.TrimPrefix(arg, "--job=")
		case strings.HasPrefix(arg, "--timeout-ms="):
			parsed, parseErr := strconv.Atoi(strings.TrimPrefix(arg, "--timeout-ms="))
			if parseErr != nil || parsed < 1 {
				return "", 0, fmt.Errorf("invalid --timeout-ms")
			}
			timeoutMs = parsed
		default:
			return "", 0, fmt.Errorf("unexpected argument %q", arg)
		}
	}
	if job == "" {
		return "", 0, fmt.Errorf("requires --job=<name>")
	}
	return job, timeoutMs, nil
}

func terminateCustodyJob(args []string) error {
	job, timeoutMs, err := parseJobArgs(args)
	if err != nil {
		usage()
		os.Exit(exitUsage)
	}
	jobHandle, exists, err := openJobByName(job, jobObjectTerminate|jobObjectQuery)
	if err != nil {
		return err
	}
	if !exists {
		// No such job object: with KILL_ON_JOB_CLOSE the job object is
		// destroyed only after every member is terminated, so absence here
		// is proof, not a guess.
		return emit(map[string]any{"state": "absent"})
	}
	defer procCloseHandle.Call(jobHandle)
	if _, _, callErr := procTerminateJobObject.Call(jobHandle, 1); !callOK(callErr) {
		return fmt.Errorf("TerminateJobObject failed: %v", callErr)
	}
	deadline := time.Now().UnixMilli() + int64(timeoutMs)
	for {
		members, err := jobMemberCount(jobHandle)
		if err != nil {
			return err
		}
		if members == 0 {
			return emit(map[string]any{"state": "absent"})
		}
		if time.Now().UnixMilli() >= deadline {
			// The termination did not prove full membership absence inside
			// the deadline. Report it honestly; the caller retains custody.
			if err := emit(map[string]any{"state": "members-remaining", "members": members}); err != nil {
				return err
			}
			os.Exit(exitNotProven)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func queryCustodyJob(args []string) error {
	job, _, err := parseJobArgs(args)
	if err != nil {
		usage()
		os.Exit(exitUsage)
	}
	jobHandle, exists, err := openJobByName(job, jobObjectQuery)
	if err != nil {
		return err
	}
	if !exists {
		return emit(map[string]any{"state": "absent"})
	}
	defer procCloseHandle.Call(jobHandle)
	members, err := jobMemberCount(jobHandle)
	if err != nil {
		return err
	}
	if members == 0 {
		// The job husk exists but no process remains in it.
		return emit(map[string]any{"state": "absent"})
	}
	return emit(map[string]any{"state": "live", "members": members})
}
