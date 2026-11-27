//go:build linux

package main

import (
	"errors"
	"path/filepath"
	"strconv"

	"golang.org/x/sys/unix"
)

type workspaceConfinedUnixHandle = workspaceConfinedLinuxHandle
type workspaceConfinedUnixPath = workspaceConfinedLinuxPath

func (p *workspaceConfinedLinuxPath) isMissing() bool {
	return p.missing
}

func workspaceTargetStatDev(stat unix.Stat_t) uint64 {
	return uint64(stat.Dev)
}

func workspaceTargetSameObject(first, second workspaceConfinedUnixHandle) bool {
	return first.dev == second.dev && first.ino == second.ino && first.kind == second.kind
}

func openWorkspaceConfinedUnixRoot(rootPath string) (workspaceConfinedUnixHandle, error) {
	return openWorkspaceConfinedLinuxRoot(rootPath)
}

func inspectWorkspaceConfinedUnixFD(fd int) (workspaceConfinedUnixHandle, error) {
	return inspectWorkspaceConfinedLinuxFD(fd)
}

func newWorkspaceConfinedUnixRootPath(rootPath string, root workspaceConfinedUnixHandle, pinnedRoot *workspaceConfinedUnixHandle) *workspaceConfinedUnixPath {
	return &workspaceConfinedLinuxPath{
		rootPath:   filepath.Clean(rootPath),
		handles:    []workspaceConfinedLinuxHandle{root},
		pinnedRoot: pinnedRoot,
	}
}

func openWorkspaceConfinedUnixPathWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string, missingAncestorAllowed bool) (*workspaceConfinedUnixPath, *workspaceConfinedDomainError) {
	return openWorkspaceConfinedLinuxPathWithRoot(pinnedRoot, rootPath, relativePath, missingAncestorAllowed)
}

func validateWorkspaceConfinedUnixRelativePath(relativePath string) ([]string, *workspaceConfinedDomainError) {
	return validateWorkspaceConfinedLinuxRelativePath(relativePath)
}

func openWorkspaceConfinedUnixAt(parent int, name string) (workspaceConfinedUnixHandle, error) {
	return openWorkspaceConfinedLinuxAt(parent, name)
}

func workspaceConfinedUnixKind(mode uint32) (workspaceConfinedKind, error) {
	return workspaceConfinedLinuxKind(mode)
}

func listWorkspaceConfinedUnixDirectory(fd int) ([]string, error) {
	return listWorkspaceConfinedLinuxDirectory(fd)
}

func readWorkspaceConfinedUnixFile(file workspaceConfinedUnixHandle, capture bool, maxCapture uint64) (string, []byte, uint64, *workspaceConfinedDomainError) {
	return readWorkspaceConfinedLinuxFile(file, capture, maxCapture)
}

func workspaceConfinedUnixPhysicalPath(fd int) (string, error) {
	return workspaceConfinedLinuxPhysicalPath(fd)
}

func revalidateWorkspaceConfinedUnixName(parent int, name string, expected workspaceConfinedUnixHandle) error {
	return revalidateWorkspaceConfinedLinuxName(parent, name, expected)
}

func workspaceTargetRenamePublish(dirfd int, staged, name string, exists bool) error {
	flags := uint(0)
	if !exists {
		flags = unix.RENAME_NOREPLACE
	}
	return unix.Renameat2(dirfd, staged, dirfd, name, flags)
}

func workspaceTargetAccessExecutable(path *workspaceConfinedUnixPath) workspaceTargetResult {
	if err := unix.Access("/proc/self/fd/"+strconv.Itoa(path.final().fd), unix.X_OK); err != nil {
		if errors.Is(err, unix.EACCES) {
			return workspaceTargetError("EACCES", "file is not executable")
		}
		return workspaceTargetError("io_failed", "execute permissions could not be read")
	}
	return workspaceTargetStatus("done")
}
