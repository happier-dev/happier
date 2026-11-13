//go:build !windows

package main

import (
	"os/signal"
	"syscall"
)

func ignoreServiceOutputDisconnect() { signal.Ignore(syscall.SIGPIPE) }
