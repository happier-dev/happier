//go:build darwin

// Darwin native process-generation witness. The numeric sysctl MIB
// {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid} returns the process's kinfo_proc,
// whose p_starttime timeval carries the subsecond birth moment that the
// whole-second `ps lstart` witness can never provide. The name-based
// `kern.proc.pid.<pid>` form does not resolve on Darwin, so the MIB is built
// numerically from documented, stable constants.
//
// The kinfo_proc layout is never trusted blindly. The helper validates the
// structure at runtime: the pid field is checked against the requested pid,
// and p_starttime is located by a uniqueness proof (exactly one in-range
// seconds value followed by a plausible microsecond field). Any ambiguity
// fails closed, because a misread birthday could authorize signalling a
// recycled pid.
package main

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

const (
	ctlKern      = 1
	kernProc     = 14
	kernProcPID  = 1
	kernBoottime = 21

	// Byte offset of p_pid inside a 64-bit Darwin kinfo_proc (empirically
	// proven on a real mac host). Every other field is located by runtime
	// validation, not by a second compiled-in offset.
	kinfoProcPidOffset = 40
)

var pidArgumentPattern = regexp.MustCompile(`^[0-9]+$`)

// callSysctl performs one numeric-MIB sysctl(2) with the caller's buffer. The
// kernel writes the returned byte count through sizePtr.
func callSysctl(mib []uint32, old []byte, size *uintptr) error {
	var oldPtr uintptr
	if old != nil {
		oldPtr = uintptr(unsafe.Pointer(&old[0]))
	}
	_, _, errno := syscall.Syscall6(
		syscall.SYS_SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		uintptr(len(mib)),
		oldPtr,
		uintptr(unsafe.Pointer(size)),
		0,
		0,
	)
	if errno != 0 {
		return errno
	}
	return nil
}

// sysctlBuffer returns the exact bytes of one numeric-MIB sysctl node: a size
// probe first, then a second call into an exactly-sized buffer.
func sysctlBuffer(mib []uint32) ([]byte, error) {
	var size uintptr
	if err := callSysctl(mib, nil, &size); err != nil {
		return nil, err
	}
	if size == 0 {
		return []byte{}, nil
	}
	buffer := make([]byte, size)
	if err := callSysctl(mib, buffer, &size); err != nil {
		return nil, err
	}
	if uintptr(len(buffer)) < size {
		return nil, fmt.Errorf("sysctl mib %v shrank below its probed size", mib)
	}
	return buffer[:size], nil
}

// readTimeval reads one struct timeval node: tv_sec (int64) at offset 0 and
// tv_usec (int32) at offset 8 on 64-bit Darwin — the empirically proven
// sec=0/usec=8 fact.
func readTimeval(mib []uint32) (int64, int32, error) {
	buffer, err := sysctlBuffer(mib)
	if err != nil {
		return 0, 0, err
	}
	if len(buffer) < 12 {
		return 0, 0, fmt.Errorf("sysctl mib %v returned %d bytes; a timeval does not fit", mib, len(buffer))
	}
	seconds := int64(*(*uint64)(unsafe.Pointer(&buffer[0])))
	usec := int32(*(*uint32)(unsafe.Pointer(&buffer[8])))
	return seconds, usec, nil
}

// locateStarttime finds p_starttime inside the kinfo_proc by uniqueness proof.
// The seconds value must fall inside [bootSecond, nowSecond] and the following
// four bytes must be a plausible microsecond field. More than one or fewer
// than one candidate is a layout the helper refuses to guess about.
func locateStarttime(buffer []byte, pid int, bootSecond int64, nowSecond int64) (int64, int32, error) {
	if len(buffer) < kinfoProcPidOffset+4 {
		return 0, 0, fmt.Errorf("kinfo_proc buffer is too small (%d bytes)", len(buffer))
	}
	observedPid := int(*(*uint32)(unsafe.Pointer(&buffer[kinfoProcPidOffset])))
	if observedPid != pid {
		return 0, 0, fmt.Errorf(
			"kinfo_proc pid field at offset %d holds %d, not the requested %d",
			kinfoProcPidOffset, observedPid, pid,
		)
	}
	candidates := 0
	foundSec := int64(0)
	foundUsec := int32(0)
	for offset := 0; offset+12 <= len(buffer); offset += 8 {
		seconds := int64(*(*uint64)(unsafe.Pointer(&buffer[offset])))
		if seconds < bootSecond || seconds > nowSecond {
			continue
		}
		usec := int32(*(*uint32)(unsafe.Pointer(&buffer[offset+8])))
		if usec < 0 || usec > 999_999 {
			continue
		}
		candidates++
		foundSec = seconds
		foundUsec = usec
	}
	if candidates != 1 {
		return 0, 0, fmt.Errorf(
			"p_starttime location is ambiguous (%d candidates between boot %d and now %d); refusing to guess",
			candidates, bootSecond, nowSecond,
		)
	}
	return foundSec, foundUsec, nil
}

func pidStartIdentityCommand(args []string) error {
	if len(args) != 1 || !pidArgumentPattern.MatchString(args[0]) {
		usage()
		os.Exit(exitUsage)
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil || pid <= 0 {
		usage()
		os.Exit(exitUsage)
	}

	bootSec, _, err := readTimeval([]uint32{ctlKern, kernBoottime})
	if err != nil {
		return err
	}
	nowSecond := time.Now().Unix()
	if bootSec <= 0 || bootSec > nowSecond {
		return fmt.Errorf("kern.boottime %d is not a plausible epoch second", bootSec)
	}

	buffer, err := sysctlBuffer([]uint32{ctlKern, kernProc, kernProcPID, uint32(pid)})
	if err != nil {
		return err
	}
	startSec, startUsec, err := locateStarttime(buffer, pid, bootSec, nowSecond)
	if err != nil {
		return err
	}
	return emit(map[string]any{"pid": pid, "sec": startSec, "usec": startUsec})
}
