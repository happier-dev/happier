import { describe, expect, it } from "vitest";

import {
    mapSessionOrganizationFolder,
    mapSessionOrganizationLabel,
    mapSessionOrganizationTag,
} from "./organizationSnapshot";

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const updatedAt = new Date("2026-01-02T00:00:00.000Z");

describe("session organization snapshot display projection", () => {
    it("preserves folder structure while explicitly marking malformed stored display unavailable", () => {
        expect(mapSessionOrganizationFolder({
            id: "folder-1",
            folderKey: "private/folder/key",
            parentKey: "private/parent/key",
            sortKey: "0001",
            displayDbValue: "{not-json",
            archivedAt: null,
            createdAt,
            updatedAt,
        }, "parent-1", "plain")).toEqual({
            folderId: "folder-1",
            folderKey: "private/folder/key",
            parentFolderId: "parent-1",
            parentFolderKey: "private/parent/key",
            sortKey: "0001",
            display: null,
            displayState: {
                status: "unavailable",
                reason: "invalid_stored_display",
            },
            archivedAt: null,
            createdAt: createdAt.getTime(),
            updatedAt: updatedAt.getTime(),
        });
    });

    it("marks valid envelopes unavailable when their storage shape disagrees with Account mode", () => {
        expect(mapSessionOrganizationTag({
            id: "tag-1",
            tagKey: "private/tag/key",
            sortKey: null,
            displayDbValue: JSON.stringify({ t: "encrypted", c: "ciphertext" }),
            archivedAt: null,
            createdAt,
            updatedAt,
        }, "plain")).toMatchObject({
            tagId: "tag-1",
            tagKey: "private/tag/key",
            display: null,
            displayState: {
                status: "unavailable",
                reason: "storage_mode_mismatch",
            },
        });

        expect(mapSessionOrganizationLabel({
            labelKind: "workspace",
            scopeKey: "private/workspace/key",
            displayDbValue: JSON.stringify({ t: "plain", v: { label: "Project" } }),
            archivedAt: null,
            createdAt,
            updatedAt,
        }, "e2ee")).toMatchObject({
            labelKind: "workspace",
            scopeKey: "private/workspace/key",
            display: null,
            displayState: {
                status: "unavailable",
                reason: "storage_mode_mismatch",
            },
        });
    });

    it("leaves readable rows on the predecessor-compatible response shape", () => {
        expect(mapSessionOrganizationTag({
            id: "tag-1",
            tagKey: "private/tag/key",
            sortKey: null,
            displayDbValue: JSON.stringify({ t: "plain", v: { label: "Project" } }),
            archivedAt: null,
            createdAt,
            updatedAt,
        }, "plain")).toEqual({
            tagId: "tag-1",
            tagKey: "private/tag/key",
            sortKey: null,
            display: { t: "plain", v: { label: "Project" } },
            archivedAt: null,
            createdAt: createdAt.getTime(),
            updatedAt: updatedAt.getTime(),
        });
    });
});
