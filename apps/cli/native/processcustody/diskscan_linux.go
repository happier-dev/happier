//go:build linux

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

type diskLinuxDirectory struct {
	fd     int
	path   string
	meta   diskMetadata
	buffer []byte
}

func diskNormalizePath(path string) string { return filepath.Clean(path) }

func diskReadLocalSnapshotCount(context.Context, string) *int64 { return nil }

func diskLinuxMetadata(stat unix.Stat_t, fsType int64) diskMetadata {
	kind := "other"
	switch stat.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		kind = "folder"
	case unix.S_IFREG:
		kind = "file"
	case unix.S_IFLNK:
		kind = "symlink"
	}
	allocated := stat.Blocks * 512
	if kind == "other" {
		allocated = 0
	}
	return diskMetadata{identity: fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), device: fmt.Sprint(stat.Dev), kind: kind, allocatedBytes: allocated, logicalBytes: stat.Size, nlink: uint64(stat.Nlink), mtimeMs: stat.Mtim.Sec*1000 + stat.Mtim.Nsec/1_000_000, sharedExtentsUnmeasured: kind == "file" && (fsType == unix.BTRFS_SUPER_MAGIC || fsType == unix.XFS_SUPER_MAGIC)}
}
func diskOpenRoot(path string) (diskDirectory, error) {
	// Hold only this worker's chain; every component is opened relative to its
	// parent and no component can turn into a symlink during traversal.
	fd, err := unix.Open(string(filepath.Separator), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, name := range strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/") {
		if name == "" {
			continue
		}
		next, openErr := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	return diskLinuxDirectoryFromFD(fd, path)
}
func diskLinuxDirectoryFromFD(fd int, path string) (diskDirectory, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	var fs unix.Statfs_t
	if err := unix.Fstatfs(fd, &fs); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &diskLinuxDirectory{fd: fd, path: path, meta: diskLinuxMetadata(stat, fs.Type), buffer: make([]byte, 64*1024)}, nil
}
func (d *diskLinuxDirectory) metadata() diskMetadata { return d.meta }
func (d *diskLinuxDirectory) close() error           { return unix.Close(d.fd) }
func (d *diskLinuxDirectory) openChild(entry diskEntry) (diskDirectory, error) {
	fd, err := unix.Openat(d.fd, entry.name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return diskLinuxDirectoryFromFD(fd, entry.path)
}
func (d *diskLinuxDirectory) entries(ctx context.Context) ([]diskEntry, string, error) {
	entries := []diskEntry{}
	backend, err := d.entryBatches(ctx, func(batch []diskEntry) error {
		entries = append(entries, batch...)
		return nil
	})
	return entries, backend, err
}
func (d *diskLinuxDirectory) entryBatches(ctx context.Context, visit func([]diskEntry) error) (string, error) {
	batch := diskEntryBuffer{visit: visit}
	var fs unix.Statfs_t
	if err := unix.Fstatfs(d.fd, &fs); err != nil {
		return "getdents64-fstatat", err
	}
	for {
		if err := ctx.Err(); err != nil {
			return "getdents64-fstatat", err
		}
		n, err := unix.ReadDirent(d.fd, d.buffer)
		if err != nil {
			return "getdents64-fstatat", err
		}
		if n == 0 {
			break
		}
		_, _, names := unix.ParseDirent(d.buffer[:n], -1, nil)
		for _, name := range names {
			entry := diskEntry{name: name, path: filepath.Join(d.path, name)}
			var stat unix.Stat_t
			entry.err = unix.Fstatat(d.fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
			if entry.err == nil {
				entry.meta = diskLinuxMetadata(stat, fs.Type)
			}
			if err := batch.append(entry); err != nil {
				return "getdents64-fstatat", err
			}
		}
		if err := batch.flush(); err != nil {
			return "getdents64-fstatat", err
		}
	}
	return "getdents64-fstatat", nil
}
func diskReadMetadata(path string, _ ...map[string]diskMetadata) (diskMetadata, error) {
	var stat unix.Stat_t
	if err := unix.Lstat(path, &stat); err != nil {
		return diskMetadata{}, err
	}
	var fs unix.Statfs_t
	fsType := int64(0)
	if stat.Mode&unix.S_IFMT != unix.S_IFLNK {
		if err := unix.Statfs(path, &fs); err == nil {
			fsType = fs.Type
		}
	}
	return diskLinuxMetadata(stat, fsType), nil
}
func diskSetBackgroundPriority() error {
	niceErr := unix.Setpriority(unix.PRIO_PROCESS, 0, 19)
	_, _, ioErr := unix.Syscall(unix.SYS_IOPRIO_SET, 1, 0, 3<<13)
	if niceErr != nil {
		return niceErr
	}
	if ioErr != 0 {
		return ioErr
	}
	return nil
}

var diskReadMountFacts = unix.Statfs

func diskShouldSkip(path, root string, meta diskMetadata) (bool, string) {
	for _, prefix := range []string{"/proc", "/sys", "/dev", "/run", "/snap"} {
		if diskPathContains(prefix, path) && !diskPathContains(prefix, root) {
			return true, "pseudo_filesystem"
		}
	}
	if meta.kind == "folder" {
		var fs unix.Statfs_t
		if diskReadMountFacts(path, &fs) == nil {
			if fs.Flags&unix.ST_RDONLY != 0 {
				return true, "read_only_filesystem"
			}
			switch fs.Type {
			case unix.FUSE_SUPER_MAGIC, unix.PROC_SUPER_MAGIC, unix.SYSFS_MAGIC, unix.DEVPTS_SUPER_MAGIC, unix.SECURITYFS_MAGIC, unix.CGROUP_SUPER_MAGIC, unix.CGROUP2_SUPER_MAGIC:
				return true, "pseudo_or_cloud_filesystem"
			}
		}
	}
	return false, "other_mount"
}

// FIEMAP is requested only by pile review. The ioctl reads extent metadata;
// file data is never read. One page is reused until FIEMAP_EXTENT_LAST.
func diskMeasureSharedExtents(path string, meta diskMetadata) (int64, int64, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return 0, meta.allocatedBytes, err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return 0, meta.allocatedBytes, err
	}
	if diskLinuxMetadata(stat, 0).identity != meta.identity {
		return 0, meta.allocatedBytes, errors.New("file changed before extent measurement")
	}
	const count = 128
	const header = 32
	const extent = 56
	const ioctlFiemap = 0xC020660B
	const extentLast = 1
	const extentShared = 0x2000
	const extentUnknown = 2
	const extentDelalloc = 4
	buffer := make([]byte, header+extent*count)
	var cursor uint64
	var shared int64
	unknown := false
	for {
		clear(buffer)
		binary.LittleEndian.PutUint64(buffer[0:8], cursor)
		binary.LittleEndian.PutUint64(buffer[8:16], ^uint64(0)-cursor)
		binary.LittleEndian.PutUint32(buffer[24:28], count)
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), ioctlFiemap, uintptr(unsafe.Pointer(&buffer[0])))
		if errno != 0 {
			return 0, meta.allocatedBytes, errno
		}
		mapped := int(binary.LittleEndian.Uint32(buffer[20:24]))
		if mapped > count {
			return 0, meta.allocatedBytes, errors.New("invalid FIEMAP extent count")
		}
		if mapped == 0 {
			break
		}
		last := false
		for i := 0; i < mapped; i++ {
			offset := header + i*extent
			logical := binary.LittleEndian.Uint64(buffer[offset : offset+8])
			length := binary.LittleEndian.Uint64(buffer[offset+16 : offset+24])
			flags := binary.LittleEndian.Uint32(buffer[offset+40 : offset+44])
			if flags&extentShared != 0 {
				shared += int64(length)
			}
			if flags&(extentUnknown|extentDelalloc) != 0 {
				unknown = true
			}
			if logical+length <= cursor {
				return 0, meta.allocatedBytes, errors.New("FIEMAP made no progress")
			}
			cursor = logical + length
			last = flags&extentLast != 0
		}
		if last {
			break
		}
	}
	private := meta.allocatedBytes - shared
	if private < 0 {
		private = 0
	}
	if unknown {
		return 0, private, nil
	}
	return private, private, nil
}
