package main

import (
	"bytes"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	managedruntime "github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime"
)

func TestManagedWrapperExitsWhenStarterClosesStdin(t *testing.T) {
	const childMarker = "HAPPIER_TEST_CLIPROXYAPI_CHILD"
	if os.Getenv(childMarker) == "1" {
		os.Args = os.Args[:1]
		main()
		os.Exit(0)
	}

	port := reserveLoopbackPort(t)
	wrapper := exec.Command(os.Args[0], "-test.run=^TestManagedWrapperExitsWhenStarterClosesStdin$")
	wrapper.Env = append(wrapper.Environ(),
		childMarker+"=1",
		"HOST=127.0.0.1",
		"PORT="+strconv.Itoa(port),
		managedruntime.DownstreamBearerEnvironmentVariable+"=fixture-bearer",
		managedruntime.ConsumerAccessPathEnvironmentVariable+"="+filepath.Join(t.TempDir(), "request-auth", "consumers.json"),
		managedruntime.ManagedPurposeConfigurationEnvironmentVariable+"="+fullyBoundPurposeConfiguration,
	)
	stdin, err := wrapper.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	var output bytes.Buffer
	wrapper.Stdout = &output
	wrapper.Stderr = &output
	if err := wrapper.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var exitErr error
	go func() {
		exitErr = wrapper.Wait()
		close(done)
	}()
	defer func() {
		select {
		case <-done:
		default:
			_ = wrapper.Process.Kill()
			<-done
		}
	}()

	awaitManagedHealth(t, port)
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		if exitErr != nil {
			t.Fatalf("wrapper exit after starter pipe closed: %v\n%s", exitErr, &output)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("healthy wrapper stayed alive after the starter pipe closed")
	}

	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("wrapper listener was not released: %v", err)
	}
	listener.Close()
}
