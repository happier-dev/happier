//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// A Session holder outlives its runner, as on Linux and macOS: it leaves the runner's owner Job
// (the daemon's cleanup terminates that Job) and owns a kill-on-close Job of its own, so its
// Agent tree ends with the holder and never with the runner.
func TestHeldLaunchLeavesTheOwnerJobAndOwnsItsAgentTree(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "held.pids")
	tag := fmt.Sprintf("v1.0123456789ab.terminal.held-%d", os.Getpid())
	jobName := censusWindowsOwnerJobName(tag)
	runner := exec.Command(executable, "-test.run=^TestHeldLaunchSubprocess$", "--", "runner", jobName, pidFile)
	runner.Env = append(os.Environ(), "HAPPIER_PROCESS_OWNER="+tag)
	runnerOut, err := runner.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	runner.Stderr = os.Stderr
	if err := runner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = runner.Process.Kill(); _ = runner.Wait() }()
	if line, err := bufio.NewReader(runnerOut).ReadString('\n'); err != nil || strings.TrimSpace(line) != "launched" {
		t.Fatalf("runner did not launch the held process: %q %v", line, err)
	}
	var heldPid, agentPid int
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(pidFile); err == nil {
			if _, err := fmt.Sscanf(string(raw), "%d %d", &heldPid, &agentPid); err == nil {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if heldPid == 0 || agentPid == 0 {
		t.Fatal("held process never reported its pids")
	}
	held := openProcessForTest(t, heldPid)
	defer syscall.CloseHandle(held)
	agent := openProcessForTest(t, agentPid)
	defer syscall.CloseHandle(agent)
	defer procTerminateProcess.Call(uintptr(agent), 1)
	defer procTerminateProcess.Call(uintptr(held), 1)

	name, err := syscall.UTF16PtrFromString(jobName)
	if err != nil {
		t.Fatal(err)
	}
	ownerJob, _, callErr := procOpenJobObjectW.Call(jobObjectQuery|jobObjectTerminate, 0, uintptr(unsafe.Pointer(name)))
	if ownerJob == 0 {
		t.Fatalf("OpenJobObjectW: %v", callErr)
	}
	defer procCloseHandle.Call(ownerJob)
	var inOwnerJob int32
	if result, _, err := procIsProcessInJobForTest.Call(uintptr(held), ownerJob, uintptr(unsafe.Pointer(&inOwnerJob))); result == 0 {
		t.Fatalf("IsProcessInJob: %v", err)
	}
	if inOwnerJob != 0 {
		t.Fatal("the held process stayed in the runner's owner Job")
	}

	// The daemon's cleanup of a dead runner terminates its owner Job: the holder and Agent stay.
	procTerminateJobObject.Call(ownerJob, 1)
	_ = runner.Wait()
	time.Sleep(500 * time.Millisecond)
	if !processAliveForTest(held) || !processAliveForTest(agent) {
		t.Fatal("terminating the runner's owner Job ended the held process or its Agent")
	}

	// The holder ends: its kill-on-close Job ends the Agent with it.
	procTerminateProcess.Call(uintptr(held), 1)
	if result, _, _ := procWaitForSingleObject.Call(uintptr(agent), 5000); result != waitObject0 {
		t.Fatal("the Agent outlived its holder")
	}
}

// Inside a Job that forbids breakaway (no runner owner Job, e.g. a CI Job) the holder still starts
// and owns its Agent tree; the helper says so on stderr for the runner to log.
func TestHeldLaunchInsideANoBreakawayJobStillOwnsItsAgentTree(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	pidFile, warnFile := filepath.Join(dir, "held.pids"), filepath.Join(dir, "warn.txt")
	runner := exec.Command(executable, "-test.run=^TestHeldLaunchSubprocess$", "--", "confined-runner", pidFile, warnFile)
	runnerOut, err := runner.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	runner.Stderr = os.Stderr
	if err := runner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = runner.Process.Kill(); _ = runner.Wait() }()
	if line, err := bufio.NewReader(runnerOut).ReadString('\n'); err != nil || strings.TrimSpace(line) != "launched" {
		t.Fatalf("runner did not launch the held process: %q %v", line, err)
	}
	var heldPid, agentPid int
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline) && agentPid == 0; time.Sleep(100 * time.Millisecond) {
		if raw, err := os.ReadFile(pidFile); err == nil {
			_, _ = fmt.Sscanf(string(raw), "%d %d", &heldPid, &agentPid)
		}
	}
	if agentPid == 0 {
		t.Fatal("held process never reported its pids")
	}
	if warning, _ := os.ReadFile(warnFile); !strings.Contains(string(warning), "forbids breakaway") {
		t.Fatalf("no breakaway warning: %q", warning)
	}
	held := openProcessForTest(t, heldPid)
	defer syscall.CloseHandle(held)
	agent := openProcessForTest(t, agentPid)
	defer syscall.CloseHandle(agent)
	defer procTerminateProcess.Call(uintptr(agent), 1)
	procTerminateProcess.Call(uintptr(held), 1)
	if result, _, _ := procWaitForSingleObject.Call(uintptr(agent), 5000); result != waitObject0 {
		t.Fatal("the Agent outlived its holder")
	}
}

func TestHeldLaunchSubprocess(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || i+1 >= len(os.Args) {
			continue
		}
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		switch os.Args[i+1] {
		case "runner":
			// The runner joins its own owner Job (as `joinCurrentWindowsSessionProcessCustody` does),
			// then launches the holder through the helper.
			join := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "native", "job-join",
				"--job="+os.Args[i+2], "--pid="+strconv.Itoa(os.Getpid()), "--holder-pid="+strconv.Itoa(os.Getpid()))
			if output, err := join.CombinedOutput(); err != nil {
				t.Fatalf("join owner: %s %v", output, err)
			}
			launch := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "native", "held-launch", "--",
				executable, "-test.run=^TestHeldLaunchSubprocess$", "--", "held", os.Args[i+3])
			// The held process inherits the helper's stdio and keeps it: do not wait for EOF on it.
			launch.Stderr = os.Stderr
			if err := launch.Run(); err != nil {
				t.Fatalf("held-launch: %v", err)
			}
			fmt.Fprintln(os.Stdout, "launched")
			for {
				time.Sleep(time.Hour)
			}
		case "confined-runner":
			// A Job without JOB_OBJECT_LIMIT_BREAKAWAY_OK, entered before launching.
			job, _, callErr := procCreateJobObjectW.Call(0, 0)
			if job == 0 {
				t.Fatalf("CreateJobObjectW: %v", callErr)
			}
			self, _ := syscall.GetCurrentProcess()
			if result, _, callErr := procAssignProcessToJobObject.Call(job, uintptr(self)); result == 0 {
				t.Fatalf("AssignProcessToJobObject: %v", callErr)
			}
			warn, err := os.Create(os.Args[i+3])
			if err != nil {
				t.Fatal(err)
			}
			launch := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "native", "held-launch", "--",
				executable, "-test.run=^TestHeldLaunchSubprocess$", "--", "held", os.Args[i+2])
			launch.Stderr = warn
			if err := launch.Run(); err != nil {
				t.Fatalf("held-launch: %v", err)
			}
			_ = warn.Close()
			fmt.Fprintln(os.Stdout, "launched")
			for {
				time.Sleep(time.Hour)
			}
		case "held":
			agent := exec.Command(executable, "-test.run=^TestOwnerHeldJobSubprocess$", "--", "member")
			if err := agent.Start(); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(os.Args[i+2], []byte(fmt.Sprintf("%d %d", os.Getpid(), agent.Process.Pid)), 0o600); err != nil {
				t.Fatal(err)
			}
			for {
				time.Sleep(time.Hour)
			}
		}
	}
}

var procIsProcessInJobForTest = kernel32.NewProc("IsProcessInJob")

func openProcessForTest(t *testing.T, pid int) syscall.Handle {
	t.Helper()
	handle, err := syscall.OpenProcess(0x1000|0x0001|0x00100000, false, uint32(pid)) // query limited, terminate, synchronize
	if err != nil {
		t.Fatalf("OpenProcess %d: %v", pid, err)
	}
	return handle
}

func processAliveForTest(handle syscall.Handle) bool {
	result, _, _ := procWaitForSingleObject.Call(uintptr(handle), 0)
	return result != waitObject0
}
