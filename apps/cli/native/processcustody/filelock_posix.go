//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// The Session's existing .live lock follows the Agent through exec and its
// descendants. A runner disconnect therefore cannot release its credential
// home; cleanup takes the same file's nonblocking exclusive lock.
func fileLockCommand(args []string) error {
	mode, index := 0, 0
	for index < len(args) {
		switch args[index] {
		case "-n":
			mode |= unix.LOCK_NB
		case "-s":
			mode |= unix.LOCK_SH
		case "-x":
			mode |= unix.LOCK_EX
		default:
			goto target
		}
		index++
	}
target:
	if mode&(unix.LOCK_SH|unix.LOCK_EX) == 0 || mode&(unix.LOCK_SH|unix.LOCK_EX) == unix.LOCK_SH|unix.LOCK_EX || len(args) < index+3 || args[index+1] != "--" {
		return errors.New("file-lock requires -s or -x, a lock path and -- command")
	}
	file, err := os.OpenFile(args[index], os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return errors.New("file-lock could not open the live lock")
	}
	defer file.Close()
	fd := int(file.Fd())
	if err := unix.Flock(fd, mode); err != nil {
		return errors.New("file-lock could not acquire the live lock")
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		return errors.New("file-lock could not inspect the live descriptor")
	}
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, flags&^unix.FD_CLOEXEC); err != nil {
		return errors.New("file-lock could not retain the live descriptor")
	}
	argv := args[index+2:]
	command, err := exec.LookPath(argv[0])
	if err != nil {
		return errors.New("file-lock target executable unavailable")
	}
	if err := syscall.Exec(command, argv, os.Environ()); err != nil {
		return errors.New("file-lock target exec failed")
	}
	return nil
}
