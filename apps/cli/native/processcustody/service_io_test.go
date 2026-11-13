package main

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

type disconnectedServiceOutput struct{ attempts int }

func (output *disconnectedServiceOutput) Write(_ []byte) (int, error) {
	output.attempts++
	return 0, errors.New("daemon reader closed")
}

func TestServiceOutputDrainsAfterDaemonDisconnect(t *testing.T) {
	destination := &disconnectedServiceOutput{}
	output := &serviceOutput{destination: destination}
	content := bytes.Repeat([]byte("service keeps writing\n"), 10000)
	// A failed daemon write must not propagate to the Service or stop draining.
	n, err := io.Copy(output, bytes.NewBuffer(content))
	if err != nil || n != int64(len(content)) {
		t.Fatalf("output lost: bytes=%d err=%v", n, err)
	}
	if _, err := output.Write([]byte("next request\n")); err != nil {
		t.Fatal(err)
	}
	if destination.attempts != 1 {
		t.Fatalf("disconnected output retried: %d", destination.attempts)
	}
}
