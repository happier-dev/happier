import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    resolveConfiguredCanonicalServerUrl,
    resolveEffectiveWebappBaseUrl,
} from "@/app/serverUrls/effectiveServerUrls";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { isPersonalHomeRuntimePurpose } from '@/app/runtime/personalHomeRuntimePurpose';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorContinuityStore } from "@/app/features/homeConnectionDescriptorContinuity";
import { readRequiredAuthenticatedHomeConnectionDescriptor } from "@/app/features/homeConnectionDescriptorPublication";
import type { JoinScreenHomeIdentity } from "./invitationService";

/**
 * How a join screen identifies the Home it is about to add someone to.
 *
 * Every fact here is read from an existing owner: server identity from the
 * identity owner, storage disclosure from the encryption policy owner, and the
 * name from the Home's own canonical address. Nothing is inferred from the
 * inviter, the request Host header, or the focused Home, none of which are the
 * Home authority.
 */

/**
 * The disclosure a join screen may honestly make about how this Home stores
 * content.
 *
 * A Home that admits both protections has no single mode to disclose, so it
 * discloses nothing rather than presenting the current default as a guarantee.
 */
export function resolveJoinScreenStorageMode(
    env: NodeJS.ProcessEnv,
): JoinScreenHomeIdentity["storageMode"] {
    const storagePolicy = readEncryptionFeatureEnv(env).storagePolicy;
    if (storagePolicy === "required_e2ee") return "encrypted";
    if (storagePolicy === "plaintext_only") return "plain";
    return null;
}

/**
 * The Home's published name.
 *
 * The name its owner gave it (the same one its features publish as `homePresentation`) leads. Until
 * it has one, the canonical address this Home was configured with is the only name it actually
 * owns; its host is what a person recognizes on a join screen. An unconfigured Home publishes
 * nothing, and the join screen says nothing rather than borrowing the application origin's
 * identity.
 */
export function resolveJoinScreenHomeDisplayName(env: NodeJS.ProcessEnv): string | null {
    const named = env.HAPPIER_HOME_DISPLAY_NAME?.trim();
    if (named) return named;
    const canonical = resolveConfiguredCanonicalServerUrl(env);
    if (!canonical) return null;
    try {
        return new URL(canonical).host;
    } catch {
        return null;
    }
}

/**
 * Who runs this Home.
 *
 * The runtime's own published purpose is the only authority for this: a Personal
 * Home is the runtime the Homes owner started as one, and it is the single
 * hosting consequence a joiner needs — that Home is a personal computer and can
 * be offline. A runtime that publishes another purpose is shared, and one that
 * publishes none says nothing rather than letting the join screen infer hosting
 * from a URL, a storage mode or whichever Home this device has focused.
 */
export function resolveJoinScreenHomeHosting(
    env: NodeJS.ProcessEnv,
): JoinScreenHomeIdentity["hosting"] {
    const purpose = String(env.HAPPIER_MANAGED_RELAY_PURPOSE ?? "").trim();
    if (!purpose) return null;
    return isPersonalHomeRuntimePurpose(purpose) ? "personal" : "shared";
}

export async function resolveJoinScreenHomeIdentity(
    env: NodeJS.ProcessEnv,
): Promise<JoinScreenHomeIdentity> {
    return {
        serverId: await getOrCreateServerIdentityId(env),
        displayName: resolveJoinScreenHomeDisplayName(env),
        storageMode: resolveJoinScreenStorageMode(env),
        hosting: resolveJoinScreenHomeHosting(env),
    };
}

/**
 * Where a join link is rendered, and which Home it addresses.
 *
 * The application origin is a renderer: it never establishes which Home the
 * link belongs to. The explicit-target carrier comes from the published Home
 * descriptor, whose identity is the stable profile reference consumed by the
 * join surface. If either owner cannot publish its fact, issuance remains
 * unavailable through the existing checks; SMTP readiness alone is insufficient.
 */
export async function resolveTeamJoinLinkTarget(
    env: NodeJS.ProcessEnv,
    continuityStore?: HomeConnectionDescriptorContinuityStore | null,
    readDescriptor: (store: HomeConnectionDescriptorContinuityStore) => Promise<HomeConnectionDescriptorV1 | undefined> =
        (store) => readRequiredAuthenticatedHomeConnectionDescriptor({ env, continuityStore: store }),
): Promise<Readonly<{
    applicationOrigin: string | null;
    homeTarget: string | null;
    serverId: string | null;
}>> {
    // The web app the Home reports in Reach, its default included: one answer for where links open.
    const applicationOrigin = resolveEffectiveWebappBaseUrl(env);
    if (!continuityStore) {
        return { applicationOrigin: null, homeTarget: null, serverId: null };
    }
    let descriptor: HomeConnectionDescriptorV1 | undefined;
    try {
        descriptor = await readDescriptor(continuityStore);
    } catch {
        return { applicationOrigin: null, homeTarget: null, serverId: null };
    }
    if (!descriptor) return { applicationOrigin: null, homeTarget: null, serverId: null };
    return {
        applicationOrigin,
        serverId: descriptor.homeServerIdentityId,
        homeTarget: JSON.stringify({
            kind: "descriptor",
            descriptor,
            authority: "trusted_enrollment",
        }),
    };
}
