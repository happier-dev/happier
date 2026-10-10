//go:build windows

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
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

func TestCustodyRunSubprocess(t *testing.T) {
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 || separator+1 >= len(os.Args) {
		return
	}

	switch os.Args[separator+1] {
	case "custody-helper":
		if err := runCustodyCommand(os.Args[separator+2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(exitOSError)
		}
		os.Exit(exitOK)
	case "custody-query":
		if err := queryCustodyJob(os.Args[separator+2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(exitOSError)
		}
		os.Exit(exitOK)
	case "custody-terminate":
		if err := terminateCustodyJob(os.Args[separator+2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(exitOSError)
		}
		os.Exit(exitOK)
	case "custody-target":
		_, _ = fmt.Fprintln(os.Stdout, "target-ready")
		_, _ = fmt.Fprintln(os.Stderr, "target-error-ready")
		_ = os.Stdin.Close()
		_ = os.Stdout.Close()
		_ = os.Stderr.Close()
		// Stay alive long enough to distinguish target half-close from custody
		// exit. The parent kills the custody helper after observing both facts.
		time.Sleep(10 * time.Second)
		os.Exit(exitOK)
	case "finite-root":
		_, _ = fmt.Fprintf(os.Stdout, "finite-root-ready:%d\n", os.Getpid())
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			os.Exit(exitOSError)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestCustodyRunSubprocess$", "--", "finite-child")
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(exitOSError)
		}
		os.Exit(37)
	case "finite-child":
		_, _ = fmt.Fprintln(os.Stdout, "finite-child-ready")
		reader := bufio.NewReader(os.Stdin)
		for {
			command, err := reader.ReadString('\n')
			if err != nil {
				os.Exit(exitOSError)
			}
			if strings.TrimSpace(command) == "release" {
				os.Exit(exitOK)
			}
			_, _ = fmt.Fprintln(os.Stdout, "finite-child-still-live")
		}
	case "finite-fast-root":
		os.Exit(37)
	}
}

func TestFiniteCustodyCompletesAlreadyEmptyJob(t *testing.T) {
	jobName := fmt.Sprintf(`Local\happier-finite-fast-root-%d`, os.Getpid())
	command := exec.Command(os.Args[0], "-test.run=^TestCustodyRunSubprocess$", "--", "custody-helper",
		"--job="+jobName, "--wait-for-job-empty", "--", os.Args[0],
		"-test.run=^TestCustodyRunSubprocess$", "--", "finite-fast-root")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 37 {
			t.Fatalf("already-empty finite job lost the root outcome: %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		<-done
		t.Fatal("finite job waited for another notification after becoming empty")
	}
}

func TestFiniteCustodyRetainsNaturalDescendantAndRootExitCode(t *testing.T) {
	t.Run("natural-child-settlement", func(t *testing.T) { testFiniteCustodyTreeSettlement(t, false) })
	t.Run("explicit-stop-after-root-exit", func(t *testing.T) { testFiniteCustodyTreeSettlement(t, true) })
}

func testFiniteCustodyTreeSettlement(t *testing.T, explicitStop bool) {
	t.Helper()
	jobName := fmt.Sprintf(`Local\happier-finite-custody-test-%d-%t`, os.Getpid(), explicitStop)
	command := exec.Command(os.Args[0], "-test.run=^TestCustodyRunSubprocess$", "--", "custody-helper",
		"--job="+jobName, "--wait-for-job-empty", "--", os.Args[0],
		"-test.run=^TestCustodyRunSubprocess$", "--", "finite-root")
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	waitObserved := false
	go func() { done <- command.Wait() }()
	t.Cleanup(func() {
		if !waitObserved {
			_ = command.Process.Kill()
			<-done
		}
	})
	reader := bufio.NewReader(stdout)
	rootReady, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(rootReady, "finite-root-ready:") {
		t.Fatalf("read actual root readiness: %q, %v", rootReady, err)
	}
	rootPID, err := strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(rootReady, "finite-root-ready:")), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	rootHandle, err := syscall.OpenProcess(0x00100000, false, uint32(rootPID)) // SYNCHRONIZE
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if rootHandle != 0 {
			_ = syscall.CloseHandle(rootHandle)
		}
	}()
	if _, err := io.WriteString(stdin, "start-child\n"); err != nil {
		t.Fatal(err)
	}
	ready, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(ready) != "finite-child-ready" {
		t.Fatalf("read retained descendant readiness: %q, %v", ready, err)
	}
	// Wait for the retained actual root handle to signal, not an output marker.
	if result, _, err := procWaitForSingleObject.Call(uintptr(rootHandle), 10_000); result != waitObject0 {
		t.Fatalf("actual root did not exit: result=%d, err=%v", result, err)
	}
	if err := syscall.CloseHandle(rootHandle); err != nil {
		t.Fatal(err)
	}
	rootHandle = 0
	// Once only the descendant remains, the native helper must keep custody.
	job, exists, err := openJobByName(jobName, jobObjectQuery)
	if err != nil || !exists {
		t.Fatalf("open established finite job: exists=%v, err=%v", exists, err)
	}
	defer procCloseHandle.Call(job)
	eventName, err := syscall.UTF16PtrFromString(jobName + "-finite-empty")
	if err != nil {
		t.Fatal(err)
	}
	openEvent := kernel32.NewProc("OpenEventW")
	emptyEvent, _, err := openEvent.Call(0x00100000, 0, uintptr(unsafe.Pointer(eventName))) // SYNCHRONIZE
	if emptyEvent == 0 {
		t.Fatalf("open finite recovery event: %v", err)
	}
	defer procCloseHandle.Call(emptyEvent)
	query := func() string {
		t.Helper()
		output, err := exec.Command(os.Args[0], "-test.run=^TestCustodyRunSubprocess$", "--",
			"custody-query", "--job="+jobName).Output()
		if err != nil {
			t.Fatalf("explicit same-job observation: %v", err)
		}
		return string(output)
	}
	if output := query(); !strings.Contains(output, `"state":"live"`) {
		t.Fatalf("retained descendant was not positively live: %s", output)
	}
	if result, _, _ := procWaitForSingleObject.Call(emptyEvent, 0); result != 258 { // WAIT_TIMEOUT
		t.Fatalf("live-job inspection signaled finite settlement: %d", result)
	}
	// The child answers after its root has exited; no natural-exit cleanup may
	// terminate it.
	if _, err := io.WriteString(stdin, "probe\n"); err != nil {
		t.Fatal(err)
	}
	answer, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(answer) != "finite-child-still-live" {
		t.Fatalf("natural descendant did not retain its lifetime: %q, %v", answer, err)
	}
	select {
	case err := <-done:
		waitObserved = true
		t.Fatalf("helper settled before its descendant: %v", err)
	default:
	}
	if explicitStop {
		output, err := exec.Command(os.Args[0], "-test.run=^TestCustodyRunSubprocess$", "--",
			"custody-terminate", "--job="+jobName).Output()
		if err != nil || !strings.Contains(string(output), `"state":"absent"`) {
			t.Fatalf("explicit Stop failed to prove the same job empty: %s, %v", output, err)
		}
	} else if _, err := io.WriteString(stdin, "release\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		waitObserved = true
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 37 {
			t.Fatalf("helper did not preserve observed root exit code 37: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not settle after its last descendant exited")
	}
	if members, err := jobMemberCount(job); err != nil || members != 0 {
		t.Fatalf("finite settlement lacked positive membership absence: members=%d, err=%v", members, err)
	}
	// Keep the exact job/event handles open to exercise the explicit recovery
	// edge independently of the normal zero notification. Positive inspection
	// must wake the same event; a live inspection above must never do so.
	if output := query(); !strings.Contains(output, `"state":"absent"`) {
		t.Fatalf("empty-job inspection lacked absence proof: %s", output)
	}
	if result, _, _ := procWaitForSingleObject.Call(emptyEvent, 0); result != waitObject0 {
		t.Fatalf("positive empty inspection did not wake finite recovery: %d", result)
	}
}

func TestCustodyRunReleasesHelperStdioAfterTargetStarts(t *testing.T) {
	jobName := fmt.Sprintf(`Local\happier-processcustody-test-%d`, os.Getpid())
	handshakePath := filepath.Join(t.TempDir(), "custody.json")
	command := exec.Command(
		os.Args[0],
		"-test.run=^TestCustodyRunSubprocess$",
		"--",
		"custody-helper",
		"--job="+jobName,
		"--handshake="+handshakePath,
		"--",
		os.Args[0],
		"-test.run=^TestCustodyRunSubprocess$",
		"--",
		"custody-target",
	)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatalf("create custody stdin pipe: %v", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("create custody stdout pipe: %v", err)
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		t.Fatalf("create custody stderr pipe: %v", err)
	}
	if err := command.Start(); err != nil {
		t.Fatalf("start custody helper: %v", err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	})

	reader := bufio.NewReader(stdout)
	ready, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read target readiness: %v", err)
	}
	if strings.TrimSpace(ready) != "target-ready" {
		t.Fatalf("unexpected target readiness: %q", ready)
	}
	stderrReader := bufio.NewReader(stderr)
	errorReady, err := stderrReader.ReadString('\n')
	if err != nil {
		t.Fatalf("read target stderr readiness: %v", err)
	}
	if strings.TrimSpace(errorReady) != "target-error-ready" {
		t.Fatalf("unexpected target stderr readiness: %q", errorReady)
	}

	for name, stream := range map[string]io.Reader{
		"stdout": reader,
		"stderr": stderrReader,
	} {
		result := make(chan error, 1)
		go func() {
			_, readErr := io.ReadAll(stream)
			result <- readErr
		}()
		select {
		case readErr := <-result:
			if readErr != nil {
				t.Fatalf("read target %s to EOF: %v", name, readErr)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("custody helper retained %s after the target closed it", name)
		}
	}

	writeResult := make(chan error, 1)
	go func() {
		_, writeErr := stdin.Write([]byte("must-observe-no-reader"))
		writeResult <- writeErr
	}()
	select {
	case writeErr := <-writeResult:
		if writeErr == nil {
			t.Fatal("custody helper retained stdin after the target closed it")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stdin write blocked because the custody helper retained the read handle")
	}
}

func TestQuoteWindowsArgumentRoundTripsThroughArgvDecoding(t *testing.T) {
	cases := []string{
		"plain",
		"",
		"with space",
		`quoted "inside"`,
		`trailing backslash \`,
		`C:\tool\`,
		`backslash before quote \"`,
		"--port=43111",
		`C:\Program Files\Tool\tool.exe serve`,
	}
	for _, value := range cases {
		quoted := quoteWindowsArgument(value)
		if decoded := decodeMSVCRTArgument(quoted); decoded != value {
			t.Fatalf("quote/decode round trip failed for %q: quoted %q decoded %q", value, quoted, decoded)
		}
	}
}

// decodeMSVCRTArgument implements the CommandLineToArgvW decoding rule for one
// argument, proving quoteWindowsArgument is its lossless inverse.
func decodeMSVCRTArgument(argument string) string {
	if argument == `""` {
		return ""
	}
	var out bytes.Buffer
	inQuotes := false
	backslashes := 0
	for i := 0; i < len(argument); i++ {
		char := argument[i]
		switch {
		case char == '\\':
			backslashes++
		case char == '"':
			for backslashes/2 > 0 {
				out.WriteByte('\\')
				backslashes--
			}
			if backslashes%2 == 1 {
				out.WriteByte('"')
				backslashes = 0
			} else {
				backslashes = 0
				inQuotes = !inQuotes
			}
		default:
			for backslashes > 0 {
				out.WriteByte('\\')
				backslashes--
			}
			out.WriteByte(char)
		}
	}
	for backslashes > 0 {
		out.WriteByte('\\')
		backslashes--
	}
	_ = inQuotes
	return out.String()
}

func TestParseRunArgsRequiresJobAndTarget(t *testing.T) {
	job, handshake, inheritedStdinArg, verbatim, finite, target, err := parseRunArgs([]string{
		"--handshake=C:\\tmp\\hs.json",
		"--job=Local\\happier-svc09-abc",
		"--target-inherited-stdin-arg=--broker-descriptor",
		"--target-windows-verbatim",
		"--",
		"tool.exe",
		"--serve",
		"443",
	})
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if job != `Local\happier-svc09-abc` || handshake != `C:\tmp\hs.json` || inheritedStdinArg != "--broker-descriptor" || !verbatim || finite {
		t.Fatalf("unexpected options: job=%q handshake=%q", job, handshake)
	}
	if len(target) != 3 || target[0] != "tool.exe" || target[2] != "443" {
		t.Fatalf("unexpected target: %v", target)
	}
	if _, _, _, _, _, _, err := parseRunArgs([]string{"--job=x", "tool.exe"}); err == nil {
		t.Fatalf("target before -- must be rejected")
	}
	if _, _, _, _, _, _, err := parseRunArgs([]string{"--", "tool.exe"}); err == nil {
		t.Fatalf("missing --job must be rejected")
	}
	if _, _, _, _, _, _, err := parseRunArgs([]string{"--job=x", "--target-inherited-stdin-arg=", "--", "tool.exe"}); err == nil {
		t.Fatalf("empty inherited-stdin argument name must be rejected")
	}
}

func TestWindowsCommandLinePreservesVerbatimCmdTail(t *testing.T) {
	target := []string{`C:\Windows\System32\cmd.exe`, "/d", "/s", "/c", `""C:\Program Files\tool.cmd" "a&b""`}
	got := windowsCommandLine(target, true)
	want := `C:\Windows\System32\cmd.exe /d /s /c ""C:\Program Files\tool.cmd" "a&b""`
	if got != want {
		t.Fatalf("verbatim command line changed cmd.exe grammar: got %q want %q", got, want)
	}
}

func TestParseJobArgs(t *testing.T) {
	job, timeout, err := parseJobArgs([]string{"--job=j1", "--timeout-ms=250"})
	if err != nil || job != "j1" || timeout != 250 {
		t.Fatalf("parse failed: job=%q timeout=%d err=%v", job, timeout, err)
	}
	if _, _, err := parseJobArgs([]string{"--timeout-ms=0"}); err == nil {
		t.Fatalf("non-positive timeout must be rejected")
	}
}
