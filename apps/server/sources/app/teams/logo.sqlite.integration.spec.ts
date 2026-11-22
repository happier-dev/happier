import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { readPublicFile } from "@/storage/blob/files";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";

import { archiveTeamInTx, createTeamInTx } from "./lifecycle";
import { isTeamLogoObjectPath, removeTeamLogo, setTeamLogo, teamLogoObjectPrefix } from "./logo";
import { admitTeamMemberInTx } from "./memberships/membershipService";
import { readStoredTeamLogo } from "./projections";

async function jpegBase64(width: number, height: number): Promise<string> {
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } })
        .jpeg()
        .toBuffer();
    return bytes.toString("base64");
}
async function pngBase64(width: number, height: number): Promise<string> {
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } })
        .png()
        .toBuffer();
    return bytes.toString("base64");
}

async function objectExists(path: string): Promise<boolean> {
    try {
        await readPublicFile(path);
        return true;
    } catch {
        return false;
    }
}

describe("Team logo custody (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-logo-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
        });
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
            update: { teamCreationPolicy: "self_service" },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function ownedTeam(encryptionMode: "plain" | "e2ee" = "plain") {
        const owner = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode },
        });
        const created = await inTx(tx => createTeamInTx(tx, {
            actorAccountId: owner.id,
            name: `Logo ${crypto.randomUUID()}`,
            requestKey: crypto.randomUUID(),
        }));
        if (!created.ok) throw new Error(`fixture Team creation failed: ${created.error}`);
        return { owner, teamId: created.team.id };
    }

    it("publishes a square, re-encoded object under the Team's own prefix", async () => {
        const { owner, teamId } = await ownedTeam();

        const result = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(1200, 600) },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.team.logo).not.toBeNull();
        expect(result.team.logo?.width).toBe(512);
        expect(result.team.logo?.height).toBe(512);
        expect(result.team.logo?.thumbhash?.length).toBeGreaterThan(0);
        expect(result.team.logo?.path.startsWith(teamLogoObjectPrefix(teamId))).toBe(true);
        expect(result.team.logo?.url).toContain(result.team.logo?.path ?? "");
        // The stored value carries no URL: the public base is a deployment fact
        // resolved at projection time, exactly as Account avatars resolve it.
        const row = await db.team.findUniqueOrThrow({ where: { id: teamId } });
        const stored = readStoredTeamLogo(row.logo);
        expect(stored).toMatchObject({ width: 512, height: 512 });
        expect(stored).not.toHaveProperty("url");

        const bytes = await readPublicFile(stored?.path ?? "");
        expect(row.logoStoredSizeBytes).toBe(BigInt(bytes.byteLength));
        const published = await sharp(Buffer.from(bytes)).metadata();
        expect(published.width).toBe(512);
        expect(published.height).toBe(512);
    });

    it("accepts an opaque PNG and stores the processor's canonical JPEG output", async () => {
        const { owner, teamId } = await ownedTeam();
        const result = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/png", dataBase64: await pngBase64(240, 180) },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.team.logo?.path.endsWith(".jpg")).toBe(true);
        const published = await sharp(Buffer.from(await readPublicFile(result.team.logo?.path ?? ""))).metadata();
        expect(published.format).toBe("jpeg");
    });

    it('does not project a persisted logo path owned by another Team', () => {
        expect(readStoredTeamLogo({
            path: 'public/teams/other-team/logo/logo.png',
            width: 32,
            height: 32,
            thumbhash: 'thumbhash',
        }, 'team-current')).toBeNull();
    });

    it("survives actual uploader Account erasure because the Team owns the object", async () => {
        const { owner, teamId } = await ownedTeam();
        const survivingOwner = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const admitted = await inTx(tx => admitTeamMemberInTx(tx, {
            teamId,
            accountId: survivingOwner.id,
            role: "owner",
            historyAccess: "all_existing",
        }));
        expect(admitted.ok).toBe(true);

        const set = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(400, 400) },
        });
        expect(set.ok).toBe(true);
        if (!set.ok) return;
        const publishedPath = set.team.logo?.path ?? "";

        await expect(deleteAccountForErasure({ accountId: owner.id }))
            .resolves.toEqual({ status: "deleted" });

        expect(await db.account.findUnique({ where: { id: owner.id } })).toBeNull();
        const stored = readStoredTeamLogo(
            (await db.team.findUniqueOrThrow({ where: { id: teamId } })).logo,
            teamId,
        );
        expect(stored?.path).toBe(publishedPath);
        expect(isTeamLogoObjectPath(teamId, stored?.path ?? "")).toBe(true);
        expect(await objectExists(publishedPath)).toBe(true);
    });

    it("replaces by committing first and deleting only the object it displaced", async () => {
        const { owner, teamId } = await ownedTeam();
        const first = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(400, 400) },
        });
        if (!first.ok) return expect(first.ok).toBe(true);
        const firstPath = first.team.logo?.path ?? "";

        const second = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(300, 500) },
        });

        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.team.logo?.path).not.toBe(firstPath);
        expect(await objectExists(second.team.logo?.path ?? "")).toBe(true);
        expect(await objectExists(firstPath)).toBe(false);
    });

    it("keeps the committed winner when two replacements race", async () => {
        const { owner, teamId } = await ownedTeam();
        const original = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(400, 400) },
        });
        expect(original.ok).toBe(true);
        if (!original.ok) return;
        const originalPath = original.team.logo?.path ?? "";

        const replacements = await Promise.all([
            setTeamLogo({
                actorAccountId: owner.id,
                teamId,
                image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(320, 500) },
            }),
            setTeamLogo({
                actorAccountId: owner.id,
                teamId,
                image: { mimeType: "image/png", dataBase64: await pngBase64(500, 320) },
            }),
        ]);
        expect(replacements.every((result) => result.ok)).toBe(true);

        const current = readStoredTeamLogo(
            (await db.team.findUniqueOrThrow({ where: { id: teamId } })).logo,
            teamId,
        );
        const candidatePaths = replacements.flatMap((result) => result.ok && result.team.logo
            ? [result.team.logo.path]
            : []);
        expect(candidatePaths).toContain(current?.path);
        expect(await objectExists(current?.path ?? "")).toBe(true);
        expect(await objectExists(originalPath)).toBe(false);
        for (const path of candidatePaths) {
            expect(await objectExists(path)).toBe(path === current?.path);
        }
    });

    it("removes the reference and its object, and answers a repeat removal unchanged", async () => {
        const { owner, teamId } = await ownedTeam("e2ee");
        const set = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/png", dataBase64: (await sharp({
                create: { width: 200, height: 200, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.4 } },
            }).png().toBuffer()).toString("base64") },
        });
        if (!set.ok) return expect(set.ok).toBe(true);
        expect(set.team.logo?.path.endsWith(".png")).toBe(true);

        await db.team.update({ where: { id: teamId }, data: { authenticationPolicy: {
            v: 1,
            mode: "restricted",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        } } });
        await expect(removeTeamLogo({ actorAccountId: owner.id, teamId }))
            .resolves.toEqual({ ok: false, error: "team_authentication_required" });
        const authentication = {
            authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
            authenticationAuthority: "present_user" as const,
        };
        const replaced = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            authentication,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(64, 64) },
        });
        expect(replaced.ok).toBe(true);
        if (!replaced.ok) return;
        expect(replaced.team.capabilities.manageMembers).toBe(true);
        const removed = await removeTeamLogo({ actorAccountId: owner.id, teamId, authentication });
        expect(removed.ok).toBe(true);
        if (!removed.ok) return;
        expect(removed.team.logo).toBeNull();
        expect(removed.team.capabilities.manageMembers).toBe(true);
        expect(await objectExists(replaced.team.logo?.path ?? "")).toBe(false);
        expect(await objectExists(set.team.logo?.path ?? "")).toBe(false);

        const again = await removeTeamLogo({ actorAccountId: owner.id, teamId });
        expect(again).toEqual({ ok: false, error: "team_authentication_required" });
    });

    it("keeps Home branding authority independent from a restricted Team credential", async () => {
        const { teamId } = await ownedTeam();
        const homeAdmin = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", homeRole: "admin" },
        });
        await db.team.update({ where: { id: teamId }, data: { authenticationPolicy: {
            v: 1,
            mode: "restricted",
            accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        } } });

        const set = await setTeamLogo({
            actorAccountId: homeAdmin.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(64, 64) },
        });
        expect(set.ok).toBe(true);
        expect((await removeTeamLogo({ actorAccountId: homeAdmin.id, teamId })).ok).toBe(true);
    });

    it("leaves the current logo intact when a replacement is refused", async () => {
        const { owner, teamId } = await ownedTeam();
        const first = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(400, 400) },
        });
        if (!first.ok) return expect(first.ok).toBe(true);

        const stranger = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const refused = await setTeamLogo({
            actorAccountId: stranger.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(300, 300) },
        });

        expect(refused).toEqual({ ok: false, error: "team_not_found" });
        const stored = readStoredTeamLogo((await db.team.findUniqueOrThrow({ where: { id: teamId } })).logo);
        expect(stored?.path).toBe(first.team.logo?.path);
        expect(await objectExists(first.team.logo?.path ?? "")).toBe(true);
    });

    it("refuses invalid, mislabelled, and decompression-bomb-shaped input before publication", async () => {
        const { owner, teamId } = await ownedTeam();

        expect(await setTeamLogo({
            actorAccountId: owner.id, teamId,
            image: { mimeType: "image/png", dataBase64: Buffer.from("not an image").toString("base64") },
        })).toEqual({ ok: false, error: "invalid_team_input" });

        // A PNG announced as a JPEG is a malformed upload, not something to
        // silently re-label at publication.
        expect(await setTeamLogo({
            actorAccountId: owner.id, teamId,
            image: { mimeType: "image/png", dataBase64: await jpegBase64(200, 200) },
        })).toEqual({ ok: false, error: "invalid_team_input" });

        const bomb = (await sharp({
            create: { width: 8_000, height: 8_000, channels: 3, background: { r: 1, g: 1, b: 1 } },
        }).png({ compressionLevel: 9 }).toBuffer()).toString("base64");
        expect(await setTeamLogo({
            actorAccountId: owner.id, teamId,
            image: { mimeType: "image/png", dataBase64: bomb },
        })).toEqual({ ok: false, error: "invalid_team_input" });

        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).logo).toBeNull();
    });

    it("retains branding through archive and refuses to change it while archived", async () => {
        const { owner, teamId } = await ownedTeam();
        const set = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(400, 400) },
        });
        if (!set.ok) return expect(set.ok).toBe(true);

        await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner.id, teamId }));

        expect(await setTeamLogo({
            actorAccountId: owner.id, teamId,
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(200, 200) },
        })).toEqual({ ok: false, error: "team_archived" });
        expect(await removeTeamLogo({ actorAccountId: owner.id, teamId }))
            .toEqual({ ok: false, error: "team_archived" });
        // Archive retains the logo, so restore needs no re-upload.
        expect(await objectExists(set.team.logo?.path ?? "")).toBe(true);
    });

    it("never treats a foreign object path as this Team's to delete", () => {
        expect(isTeamLogoObjectPath("team-a", "public/teams/team-b/logo/x.jpg")).toBe(false);
        expect(isTeamLogoObjectPath("team-a", "public/users/acct/avatars/x.jpg")).toBe(false);
        expect(isTeamLogoObjectPath("team-a", "public/teams/team-a/logo/x.jpg")).toBe(true);
    });

    it("publishes no candidate and commits nothing when Teams is disabled", async () => {
        const { owner, teamId } = await ownedTeam();
        const result = await setTeamLogo({
            actorAccountId: owner.id,
            teamId,
            env: { ...process.env, HAPPIER_BUILD_FEATURES_DENY: "teams" },
            image: { mimeType: "image/jpeg", dataBase64: await jpegBase64(300, 300) },
        });

        expect(result).toEqual({ ok: false, error: "teams_unavailable" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).logo).toBeNull();
    });
});
