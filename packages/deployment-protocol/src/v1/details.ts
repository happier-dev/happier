import { z } from 'zod/mini';

import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentHeaderV1Schema } from './environment.js';
import { DeploymentTargetLinkContentV1Schema, DeploymentTargetLinkHeaderV1Schema } from './target.js';
import { DeploymentContentV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentStepV1Schema } from './deployment.js';
import { DeploymentIdentifierV1Schema } from './ids.js';
import { DeploymentEnvironmentHealthAggregateV1Schema } from './health.js';

/** Labels come from admitted Source metadata and private Artifact headers, never their bodies. */
export const DeploymentEnvironmentCollectionV1Schema = z.strictObject({
    items: z.array(z.strictObject({ environment: DeploymentEnvironmentHeaderV1Schema, title: z.string(),
        projectSourceName: z.optional(z.nullable(z.string())),
        /** Unknown unless the carried receipt is the runtime link's actual active deployment. */
        liveVersionTitle: z.optional(z.nullable(z.string())),
        runtimeTargetLink: z.optional(z.nullable(DeploymentTargetLinkHeaderV1Schema)),
        currentDeployment: z.optional(z.nullable(z.extend(DeploymentReceiptHeaderV1Schema, {
            title: z.optional(z.string()),
            steps: z.optional(z.nullable(z.array(DeploymentStepV1Schema))),
        }))) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    coverage: z.optional(z.enum(['complete', 'partial'])),
});
export type DeploymentEnvironmentCollectionV1 = z.infer<typeof DeploymentEnvironmentCollectionV1Schema>;

/** Header-only history labels; old/source test transports may omit the opened label. */
export const DeploymentReceiptHistoryV1Schema = z.strictObject({
    ok: z.literal(true), items: z.array(z.extend(DeploymentReceiptHeaderV1Schema, { title: z.optional(z.string()) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
});
export type DeploymentReceiptHistoryV1 = z.infer<typeof DeploymentReceiptHistoryV1Schema>;

/** Artifact bodies serialize ContentV1 directly. The Artifact owner opens its mode-aware envelope. */
export const DeploymentEnvironmentDetailV1Schema = z.strictObject({
    environment: DeploymentEnvironmentHeaderV1Schema,
    content: DeploymentEnvironmentContentV1Schema,
    targetLinks: z.array(z.strictObject({
        targetLink: DeploymentTargetLinkHeaderV1Schema,
        // Custody headers remain available without demanding private link bodies.
        content: z.optional(DeploymentTargetLinkContentV1Schema),
    })),
    healthAggregate: z.optional(DeploymentEnvironmentHealthAggregateV1Schema),
});
export type DeploymentEnvironmentDetailV1 = z.infer<typeof DeploymentEnvironmentDetailV1Schema>;

export const DeploymentReceiptDetailV1Schema = z.strictObject({
    deployment: DeploymentReceiptHeaderV1Schema,
    content: DeploymentContentV1Schema,
    /** Supplied by the admitted receipt read, not private Artifact content or a client-side permission check. */
    cancellable: z.optional(z.boolean()),
});
export type DeploymentReceiptDetailV1 = z.infer<typeof DeploymentReceiptDetailV1Schema>;
