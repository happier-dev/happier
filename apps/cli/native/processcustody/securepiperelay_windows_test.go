//go:build windows

package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/user"
	"testing"
	"time"

	winio "github.com/Microsoft/go-winio"
)

func TestSecurePipeListenerUsesUserOnlyDACLAndWitnessesExactClientPID(t *testing.T) {
	current, err := user.Current()
	if err != nil || current.Uid == "" {
		t.Fatalf("resolve current user SID: %v", err)
	}
	config := securePipeListenerConfig(current.Uid)
	expectedDescriptor := fmt.Sprintf("D:P(A;;GA;;;%s)", current.Uid)
	if config.SecurityDescriptor != expectedDescriptor {
		t.Fatalf("unexpected security descriptor %q", config.SecurityDescriptor)
	}
	pipeName := fmt.Sprintf(`\\.\pipe\happier-workspace-sync-test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	listener, err := winio.ListenPipe(pipeName, config)
	if err != nil {
		t.Fatalf("listen on secured pipe: %v", err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	acceptErrors := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			acceptErrors <- acceptErr
			return
		}
		accepted <- connection
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := winio.DialPipeContext(ctx, pipeName)
	if err != nil {
		t.Fatalf("dial secured pipe: %v", err)
	}
	defer client.Close()
	clientDescriptor, ok := client.(fileDescriptor)
	if !ok {
		t.Fatal("pipe client did not expose its native handle")
	}
	serverPID, err := namedPipeServerSameUserPid(clientDescriptor.Fd())
	if err != nil || serverPID != os.Getpid() {
		t.Fatalf("same-user server PID = %d, want %d: %v", serverPID, os.Getpid(), err)
	}
	var server net.Conn
	select {
	case server = <-accepted:
	case acceptErr := <-acceptErrors:
		t.Fatalf("accept secured pipe: %v", acceptErr)
	case <-ctx.Done():
		t.Fatal("accept secured pipe timed out")
	}
	defer server.Close()
	descriptor, ok := server.(fileDescriptor)
	if !ok {
		t.Fatal("secured pipe did not expose its native handle")
	}
	clientPID, err := namedPipeClientPid(descriptor.Fd())
	if err != nil {
		t.Fatalf("witness client PID: %v", err)
	}
	if clientPID != os.Getpid() {
		t.Fatalf("client PID = %d, want %d", clientPID, os.Getpid())
	}
}
