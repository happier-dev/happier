import {
    defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
    defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { defineTriagePagedPanelPageV1 } from '../../v1/pagedPanel.js';

const closed = { policy: 'closed' } as const;
export const ForgeReleaseIdV1Schema = defineProtocolString({ pattern: '^[1-9][0-9]*$' });
export const ForgeReleaseBooleanV1Schema = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const count = defineProtocolNumber({ integer: true, minimum: 0 });
const text = defineProtocolString();
const nonempty = defineProtocolString({ minLength: 1 });
export const ForgeReleaseRefV1Schema = defineProtocolObject({
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema, repositoryId: ForgeReleaseIdV1Schema,
    releaseId: ForgeReleaseIdV1Schema,
}, closed);
export const ForgeReleaseAssetV1Schema = defineProtocolObject({
    assetId: ForgeReleaseIdV1Schema, name: nonempty, label: text.nullable(), contentType: nonempty,
    size: count, state: nonempty, digest: text.nullable().optional(), downloadCount: count.optional(),
    updatedAt: nonempty.optional(), webUrl: nonempty.optional(),
}, closed);
export type ForgeReleaseAssetV1 = ReturnType<typeof ForgeReleaseAssetV1Schema.parse>;
const incomplete = defineProtocolUnion([defineProtocolLiteral('pagination'), defineProtocolLiteral('provider_ceiling')]);
export const ForgeReleaseAssetPageV1Schema = defineTriagePagedPanelPageV1(ForgeReleaseAssetV1Schema, incomplete);
export type ForgeReleaseAssetPageV1 = ReturnType<typeof ForgeReleaseAssetPageV1Schema.parse>;
export const ForgeReleaseV1Schema = defineProtocolObject({
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema, repositoryId: ForgeReleaseIdV1Schema,
    releaseId: ForgeReleaseIdV1Schema, tagName: nonempty, targetCommitish: nonempty,
    name: text.nullable(), body: text.nullable(), draft: ForgeReleaseBooleanV1Schema,
    prerelease: ForgeReleaseBooleanV1Schema, immutable: ForgeReleaseBooleanV1Schema.optional(),
    createdAt: nonempty, updatedAt: nonempty.optional(), publishedAt: nonempty.nullable(),
    webUrl: nonempty, author: nonempty.optional(),
    repositoryVisibility: defineProtocolUnion([defineProtocolLiteral('public'), defineProtocolLiteral('private'), defineProtocolLiteral('unknown')]),
    /** Embedded assets are retained evidence, never assumed to be a complete page. */
    assets: ForgeReleaseAssetPageV1Schema,
}, closed);
export type ForgeReleaseV1 = ReturnType<typeof ForgeReleaseV1Schema.parse>;
export const ForgeReleasePageV1Schema = defineTriagePagedPanelPageV1(ForgeReleaseV1Schema, incomplete);
export type ForgeReleasePageV1 = ReturnType<typeof ForgeReleasePageV1Schema.parse>;
export const ForgeReleaseGeneratedNotesV1Schema = defineProtocolObject({ name: text, body: text }, closed);
export type ForgeReleaseGeneratedNotesV1 = ReturnType<typeof ForgeReleaseGeneratedNotesV1Schema.parse>;
