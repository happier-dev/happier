//go:build linux

package main

import (
	"bufio"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestFileLockRetainsLiveHomeUntilAgentExits(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".live")
	agent := exec.Command(helperBinaryPath, "file-lock", "-s", path, "--", "sh", "-c", "printf 'ready\\n'; read -r end; exit 17")
	input, err := agent.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := agent.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = agent.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = input.Close(); _ = agent.Wait() }()
	ready, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || ready != "ready\n" {
		t.Fatalf("locked Agent did not start: %q %v", ready, err)
	}
	if err = exec.Command(helperBinaryPath, "file-lock", "-n", "-x", path, "--", "true").Run(); err == nil {
		t.Fatal("exclusive cleanup acquired a live Agent's shared lock")
	}
	if err = exec.Command(helperBinaryPath, "file-lock", "-n", "-s", path, "--", "true").Run(); err != nil {
		t.Fatalf("another Agent could not join its Session's shared lock: %v", err)
	}
	_ = input.Close()
	if err = agent.Wait(); err == nil || agent.ProcessState.ExitCode() != 17 {
		t.Fatalf("Agent exit was not preserved: %v", err)
	}
	if err = exec.Command(helperBinaryPath, "file-lock", "-n", "-x", path, "--", "true").Run(); err != nil {
		t.Fatalf("ended Agent kept its delivered home locked: %v", err)
	}
}
