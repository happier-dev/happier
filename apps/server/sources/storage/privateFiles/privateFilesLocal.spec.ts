import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

    it("writes nested files with lazy root creation", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const parentDir = await mkdtemp(join(tmpdir(), "happier-private-files-parent-"));
        const dir = join(parentDir, "lazy-root");
        try {
            const backend = createLocalPrivateFilesBackend({
                rootDir: dir,
            });

            await backend.writePrivateFile("private/accounts/acct-1/pets/pet-1/sheet.webp", new Uint8Array([4, 5, 6]));

            expect(await backend.readPrivateFile("private/accounts/acct-1/pets/pet-1/sheet.webp")).toEqual(new Uint8Array([4, 5, 6]));
        } finally {
            await rm(parentDir, { recursive: true, force: true });
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

    it("rejects reads through symlinked private directories", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const dir = await mkdtemp(join(tmpdir(), "happier-private-files-"));
        const outsideDir = await mkdtemp(join(tmpdir(), "happier-private-files-outside-"));
        try {
            const backend = createLocalPrivateFilesBackend({
                rootDir: dir,
            });
            await backend.init();
            await mkdir(join(outsideDir, "accounts", "acct-1", "pets", "pet-1"), { recursive: true });
            await writeFile(join(outsideDir, "accounts", "acct-1", "pets", "pet-1", "sheet.webp"), new Uint8Array([7]));
            await symlink(outsideDir, join(dir, "private"), "dir");

            await expect(
                backend.readPrivateFile("private/accounts/acct-1/pets/pet-1/sheet.webp"),
            ).rejects.toThrow(/invalid|symlink/i);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it("rejects deletes through symlinked private directories", async () => {
        const { createLocalPrivateFilesBackend } = await import("./privateFilesLocal");
        const dir = await mkdtemp(join(tmpdir(), "happier-private-files-"));
        const outsideDir = await mkdtemp(join(tmpdir(), "happier-private-files-outside-"));
        const outsideFile = join(outsideDir, "accounts", "acct-1", "pets", "pet-1", "sheet.webp");
        try {
            const backend = createLocalPrivateFilesBackend({
                rootDir: dir,
            });
            await backend.init();
            await mkdir(join(outsideDir, "accounts", "acct-1", "pets", "pet-1"), { recursive: true });
            await writeFile(outsideFile, new Uint8Array([8]));
            await symlink(outsideDir, join(dir, "private"), "dir");

            expect(backend.deletePrivateFile).toBeDefined();
            await expect(
                backend.deletePrivateFile?.("private/accounts/acct-1/pets/pet-1/sheet.webp"),
            ).rejects.toThrow(/invalid|symlink/i);
            expect(await readFile(outsideFile)).toEqual(Buffer.from([8]));
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });
});
