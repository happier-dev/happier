package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
)

// The Service owns its output pipes. A daemon can stop reading without closing
// the Service's writer: forward while connected, then drain until process exit.
// No output is persisted here; the daemon retains its normal redaction/log owner.
type serviceOutput struct {
	destination io.Writer
}

func (output *serviceOutput) Write(bytes []byte) (int, error) {
	if output.destination != nil {
		if _, err := output.destination.Write(bytes); err != nil {
			output.destination = nil
		}
	}
	return len(bytes), nil
}

func serviceIOCommand(args []string) error {
	if len(args) < 2 || args[0] != "--" {
		return errors.New("service-io requires a target command")
	}
	ignoreServiceOutputDisconnect()
	command := exec.Command(args[1], args[2:]...)
	command.Stdin = os.Stdin
	command.Stdout = &serviceOutput{destination: os.Stdout}
	command.Stderr = &serviceOutput{destination: os.Stderr}
	if err := command.Run(); err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			code := exited.ExitCode()
			if code < 0 {
				code = 1
			}
			os.Exit(code)
		}
		return err
	}
	return nil
}
