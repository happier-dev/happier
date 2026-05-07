import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("privateFilesLocal", () => {
    it("writes and reads account-private bytes without exposing a public URL contract", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const dir = await mkdtemp(join(tmpdir(), "happier-private-files-"));
        try {
            const backend = createLocalPrivateFilesBackend({
                rootDir: dir,
            });
            await backend.init();

            await backend.writePrivateFile("private/accounts/acct-1/pets/pet-1/sheet.webp", new Uint8Array([1, 2, 3]));

            expect(await backend.readPrivateFile("private/accounts/acct-1/pets/pet-1/sheet.webp")).toEqual(new Uint8Array([1, 2, 3]));
            expect("getPublicUrl" in backend).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("rejects private object keys that traverse outside the private root", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const dir = await mkdtemp(join(tmpdir(), "happier-private-files-"));
        try {
            const backend = createLocalPrivateFilesBackend({
                rootDir: dir,
            });
            await backend.init();

            await expect(
                backend.writePrivateFile("../escape.webp", new Uint8Array([1])),
            ).rejects.toThrow(/invalid/i);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("rejects writes through symlinked private directories", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const dir = await mkdtemp(join(tmpdir(), "happier-private-files-"));
        const outsideDir = await mkdtemp(join(tmpdir(), "happier-private-files-outside-"));
        try {
            const backend = createLocalPrivateFilesBackend({
                rootDir: dir,
            });
            await backend.init();
            await symlink(outsideDir, join(dir, "private"), "dir");

            await expect(
                backend.writePrivateFile("private/accounts/acct-1/pets/pet-1/sheet.webp", new Uint8Array([9])),
            ).rejects.toThrow(/invalid|symlink/i);
            await expect(
                readFile(join(outsideDir, "accounts", "acct-1", "pets", "pet-1", "sheet.webp")),
            ).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("creates private-file directories and payloads with restrictive permissions", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const dir = await mkdtemp(join(tmpdir(), "happier-private-files-"));
        const rootDir = join(dir, "storage");
        const key = "private/accounts/acct-1/pets/pet-1/sheet.webp";
        const leafDir = join(rootDir, "private", "accounts", "acct-1", "pets", "pet-1");
        const leafFile = join(leafDir, "sheet.webp");

        try {
            const backend = createLocalPrivateFilesBackend({ rootDir });
            await backend.init();
            await backend.writePrivateFile(key, new Uint8Array([7, 8, 9]));

            expect(await backend.readPrivateFile(key)).toEqual(new Uint8Array([7, 8, 9]));

            if (process.platform !== "win32") {
                expect((await lstat(rootDir)).mode & 0o777).toBe(0o700);
                expect((await lstat(leafDir)).mode & 0o777).toBe(0o700);
                expect((await lstat(leafFile)).mode & 0o777).toBe(0o600);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
