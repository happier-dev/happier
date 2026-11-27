//go:build darwin

package main

import (
	"errors"
	"path/filepath"

	"golang.org/x/sys/unix"
)

type workspaceConfinedUnixHandle = workspaceConfinedDarwinHandle
type workspaceConfinedUnixPath = workspaceConfinedDarwinHeldPath

func (p *workspaceConfinedDarwinHeldPath) isMissing() bool {
	return p.missingIndex >= 0
}

func workspaceTargetStatDev(stat unix.Stat_t) uint64 {
	return uint64(uint32(stat.Dev))
}

func workspaceTargetSameObject(first, second workspaceConfinedUnixHandle) bool {
	return sameWorkspaceConfinedDarwinObject(first, second)
}

func openWorkspaceConfinedUnixRoot(rootPath string) (workspaceConfinedUnixHandle, error) {
	_, handle, err := openWorkspaceConfinedDarwinRoot(rootPath)
	return handle, err
}

func inspectWorkspaceConfinedUnixFD(fd int) (workspaceConfinedUnixHandle, error) {
	return inspectWorkspaceConfinedDarwinFD(fd)
}

func newWorkspaceConfinedUnixRootPath(rootPath string, root workspaceConfinedUnixHandle, pinnedRoot *workspaceConfinedUnixHandle) *workspaceConfinedUnixPath {
	return &workspaceConfinedDarwinHeldPath{
		rootPath:     filepath.Clean(rootPath),
		handles:      []workspaceConfinedDarwinHandle{root},
		missingIndex: -1,
		pinnedRoot:   pinnedRoot,
	}
}

func openWorkspaceConfinedUnixPathWithRoot(pinnedRoot *workspaceConfinedUnixHandle, rootPath, relativePath string, missingAncestorAllowed bool) (*workspaceConfinedUnixPath, *workspaceConfinedDomainError) {
	return openWorkspaceConfinedDarwinHeldPathWithRoot(pinnedRoot, rootPath, relativePath, missingAncestorAllowed)
}

func validateWorkspaceConfinedUnixRelativePath(relativePath string) ([]string, *workspaceConfinedDomainError) {
	return validateWorkspaceConfinedDarwinRelativePath(relativePath)
}

func openWorkspaceConfinedUnixAt(parent int, name string) (workspaceConfinedUnixHandle, error) {
	return openWorkspaceConfinedDarwinComponent(parent, name)
}

func workspaceConfinedUnixKind(mode uint32) (workspaceConfinedKind, error) {
	return workspaceConfinedDarwinKind(uint16(mode))
}

func listWorkspaceConfinedUnixDirectory(fd int) ([]string, error) {
	return listWorkspaceConfinedDarwinDirectory(fd)
}

func readWorkspaceConfinedUnixFile(file workspaceConfinedUnixHandle, capture bool, maxCapture uint64) (string, []byte, uint64, *workspaceConfinedDomainError) {
	return readWorkspaceConfinedDarwinFile(file, capture, maxCapture)
}

func workspaceConfinedUnixPhysicalPath(fd int) (string, error) {
	return workspaceConfinedDarwinPhysicalPath(fd)
}

func revalidateWorkspaceConfinedUnixName(parent int, name string, expected workspaceConfinedUnixHandle) error {
	return revalidateWorkspaceConfinedDarwinName(parent, name, expected)
}

func workspaceTargetRenamePublish(dirfd int, staged, name string, exists bool) error {
	if !exists {
		return unix.RenameatxNp(dirfd, staged, dirfd, name, unix.RENAME_EXCL)
	}
	return unix.Renameat(dirfd, staged, dirfd, name)
}

func workspaceTargetAccessExecutable(path *workspaceConfinedUnixPath) workspaceTargetResult {
	final := path.final()
	if final.kind == workspaceConfinedKindDirectory {
		// Check the held directory descriptor directly via "." so it stays pinned
		// even if rootPath was moved and works for both root ("") and subdirectories.
		if err := unix.Faccessat(final.fd, ".", unix.X_OK, 0); err != nil {
			if errors.Is(err, unix.EACCES) {
				return workspaceTargetError("EACCES", "file is not executable")
			}
			return workspaceTargetError("io_failed", "execute permissions could not be read")
		}
		return workspaceTargetStatus("done")
	}
	if len(path.components) == 0 || final.kind == workspaceConfinedKindSymlink {
		return workspaceTargetError("conflict_changed", "workspace entry changed before access check")
	}
	parent := path.handles[len(path.handles)-2]
	name := path.components[len(path.components)-1]
	if err := revalidateWorkspaceConfinedDarwinName(parent.fd, name, final); err != nil {
		return workspaceTargetError("conflict_changed", "workspace entry changed before access check")
	}
	accessErr := unix.Faccessat(parent.fd, name, unix.X_OK, unix.AT_SYMLINK_NOFOLLOW)
	if err := revalidateWorkspaceConfinedDarwinName(parent.fd, name, final); err != nil {
		return workspaceTargetError("conflict_changed", "workspace entry changed during access check")
	}
	if accessErr != nil {
		if errors.Is(accessErr, unix.EACCES) {
			return workspaceTargetError("EACCES", "file is not executable")
		}
		return workspaceTargetError("io_failed", "execute permissions could not be read")
	}
	return workspaceTargetStatus("done")
}
