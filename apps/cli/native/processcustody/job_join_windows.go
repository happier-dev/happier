//go:build windows

package main

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func parseJobHandleOptions(args []string) (map[string]string, error) {
	options := make(map[string]string)
	for _, argument := range args {
		key, value, found := strings.Cut(argument, "=")
		if !found || value == "" || options[key] != "" {
			return nil, fmt.Errorf("invalid job handle option")
		}
		switch key {
		case "--job", "--pid", "--holder-pid", "--holder-handle", "--holder-start-time-ms":
		default:
			return nil, fmt.Errorf("unknown job handle option")
		}
		options[key] = value
	}
	return options, nil
}

func openOwnJobProcess(value string, access uint32) (windows.Handle, error) {
	pid, err := strconv.ParseUint(value, 10, 32)
	if err != nil || pid <= 1 {
		return 0, fmt.Errorf("requires a valid process pid")
	}
	handle, err := windows.OpenProcess(access|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, err
	}
	principal, err := censusWindowsPrincipal(handle)
	own, ownErr := censusWindowsPrincipal(windows.CurrentProcess())
	if err != nil || ownErr != nil || principal == nil || own == nil || principal.Value != own.Value {
		windows.CloseHandle(handle)
		return 0, fmt.Errorf("job handle process principal is not the current principal")
	}
	return handle, nil
}

func jobHolderStart(handle windows.Handle) (int64, error) {
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return 0, err
	}
	start, err := censusWindowsStart(creation)
	return start.StartTimeMs, err
}

// Transfer custody into the already-running owner. Assignment does not retain
// a named Job handle: the owner must hold this non-inheritable handle until its
// own exit (runner) or terminal disposal (PTY host). No kill-on-close limit.
func joinCustodyJob(args []string) error {
	opts, err := parseJobHandleOptions(args)
	if err != nil {
		return err
	}
	if opts["--job"] == "" || len(opts) != 3 {
		return fmt.Errorf("job-join requires --job, --pid and --holder-pid")
	}
	target, err := openOwnJobProcess(opts["--pid"], windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(target)
	// The host owns canonical tag parsing. Here the name must encode that
	// exact live target marker: a stale PID cannot join an unrelated process.
	encoded, ok := strings.CutPrefix(opts["--job"], `Local\happier-owner-`)
	expected, decodeErr := base64.RawURLEncoding.DecodeString(encoded)
	if !ok || decodeErr != nil || len(expected) == 0 || censusWindowsOwnerJobName(string(expected)) != opts["--job"] {
		return fmt.Errorf("job-join requires an owner-tag-derived Job name")
	}
	principal, err := censusWindowsPrincipal(target)
	if err != nil {
		return err
	}
	tag, _, err := censusWindowsEnvironment(int(mustJobPid(opts["--pid"])), principal)
	if err != nil || tag != string(expected) {
		return fmt.Errorf("target ownership tag changed or unavailable")
	}
	holder, err := openOwnJobProcess(opts["--holder-pid"], windows.PROCESS_DUP_HANDLE)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(holder)
	start, err := jobHolderStart(holder)
	if err != nil {
		return err
	}
	name, err := syscall.UTF16PtrFromString(opts["--job"])
	if err != nil {
		return err
	}
	job, _, callErr := procCreateJobObjectW.Call(0, uintptr(unsafe.Pointer(name)))
	if job == 0 {
		return fmt.Errorf("CreateJobObjectW: %v", callErr)
	}
	defer procCloseHandle.Call(job)
	var limits jobObjectExtendedLimitInformation
	if result, _, err := procQueryInformationJobObject.Call(job, jobObjectExtendedLimitInfoClass, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits), 0); result == 0 {
		return fmt.Errorf("QueryInformationJobObject: %v", err)
	}
	if limits.BasicLimitInformation.LimitFlags&jobObjectLimitKillOnJobClose != 0 {
		return fmt.Errorf("owner-held Job must not kill on close")
	}
	// A Session holder breaks away from its runner's owner Job (held-launch), as it outlives the
	// runner on Linux and macOS.
	if limits.BasicLimitInformation.LimitFlags&jobObjectLimitBreakawayOk == 0 {
		limits.BasicLimitInformation.LimitFlags |= jobObjectLimitBreakawayOk
		if result, _, err := procSetInformationJobObject.Call(job, jobObjectExtendedLimitInfoClass, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits)); result == 0 {
			return fmt.Errorf("SetInformationJobObject: %v", err)
		}
	}
	if assigned, _, err := procAssignProcessToJobObject.Call(job, uintptr(target)); assigned == 0 {
		return fmt.Errorf("AssignProcessToJobObject: %v", err)
	}
	var transferred windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(job), holder, &transferred, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return err
	}
	if err := emit(map[string]any{"state": "joined", "job": opts["--job"], "pid": mustJobPid(opts["--pid"]), "holderPid": mustJobPid(opts["--holder-pid"]), "holderStartTimeMs": start, "holderHandle": strconv.FormatUint(uint64(transferred), 10)}); err != nil {
		var recovered windows.Handle
		if windows.DuplicateHandle(holder, transferred, windows.CurrentProcess(), &recovered, 0, false, windows.DUPLICATE_CLOSE_SOURCE|windows.DUPLICATE_SAME_ACCESS) == nil {
			windows.CloseHandle(recovered)
		}
		return err
	}
	return nil
}

func mustJobPid(value string) uint64 { pid, _ := strconv.ParseUint(value, 10, 32); return pid }

// Release the PTY host's exact handle only while its process generation still
// matches. A recycled holder PID must never authorize closing another handle.
func releaseCustodyJobHandle(args []string) error {
	opts, err := parseJobHandleOptions(args)
	if err != nil {
		return err
	}
	if len(opts) != 3 {
		return fmt.Errorf("job-release requires holder pid, handle and start time")
	}
	holder, err := openOwnJobProcess(opts["--holder-pid"], windows.PROCESS_DUP_HANDLE)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(holder)
	expected, err := strconv.ParseInt(opts["--holder-start-time-ms"], 10, 64)
	if err != nil || expected <= 0 {
		return fmt.Errorf("invalid holder generation")
	}
	start, err := jobHolderStart(holder)
	if err != nil || start != expected {
		return fmt.Errorf("holder generation changed")
	}
	value, err := strconv.ParseUint(opts["--holder-handle"], 10, int(unsafe.Sizeof(uintptr(0))*8))
	if err != nil || value == 0 || uintptr(value) == invalidHandleValue {
		return fmt.Errorf("invalid holder handle")
	}
	// Validate the source's type before CLOSE_SOURCE: never close an unrelated
	// object if an invalid handle is accidentally supplied.
	var witness windows.Handle
	if err := windows.DuplicateHandle(holder, windows.Handle(value), windows.CurrentProcess(), &witness, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return err
	}
	defer windows.CloseHandle(witness)
	if _, err := jobMemberCount(uintptr(witness)); err != nil {
		return err
	}
	var released windows.Handle
	if err := windows.DuplicateHandle(holder, windows.Handle(value), windows.CurrentProcess(), &released, 0, false, windows.DUPLICATE_CLOSE_SOURCE|windows.DUPLICATE_SAME_ACCESS); err != nil {
		return err
	}
	windows.CloseHandle(released)
	return emit(map[string]any{"state": "released"})
}
