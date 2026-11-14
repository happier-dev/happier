import { TriageTaskCreationPlacesInputV1Schema, TriageTaskCreationPlacesConnectedAccountInputV1Schema, TriageTaskCreationPlacesCredentialInputV1Schema, TriageTaskCreationPlacesResultV1Schema } from './creationPlaces.js';
import {
    defineContributionPoint,
    defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';

/** A workspace source keeps its typed result alive through native approval. */
export const TRIAGE_REVIEW_WORKSPACE_OPERATION_V1 = Object.freeze({
    version: 1,
    visibility: 'activity',
    progress: 'reported',
    presentation: { onStart: 'current' },
} as const satisfies NonNullable<PluginActionDeclaration['operation']>);

import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from './bounds.js';
import { TriageSourceDescriptorV1Schema as rawTriageSourceDescriptorV1Schema } from './descriptor.js';
import { TriageDetailSurfaceInputV1Schema as rawTriageDetailSurfaceInputV1Schema } from './detail.js';
import { TriagePullRequestStatusResultV1Schema as rawTriagePullRequestStatusResultV1Schema } from './pullRequestStatus.js';
import { TriageSourceReadFixPullRequestsResultV1Schema as rawTriageSourceReadFixPullRequestsResultV1Schema } from './fixPullRequests.js';
import {
    TriageListScopeUnitsInputV1Schema as rawTriageListScopeUnitsInputV1Schema, TriageListScopeUnitsResultV1Schema as rawTriageListScopeUnitsResultV1Schema,
    TriageListScopeUnitsConnectedAccountInputV1Schema as rawTriageListScopeUnitsConnectedAccountInputV1Schema, TriageListScopeUnitsCredentialInputV1Schema as rawTriageListScopeUnitsCredentialInputV1Schema,
} from './scopeSelection.js';
import {
    TriageListInstancesInputV1Schema as rawTriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema as rawTriageListInstancesResultV1Schema,
} from './instances.js';
import {
    TriageGetConnectedAccountInputV1Schema as rawTriageGetConnectedAccountInputV1Schema,
    TriageGetCredentialInputV1Schema as rawTriageGetCredentialInputV1Schema,
    TriageGetInputV1Schema as rawTriageGetInputV1Schema,
    TriageGetResultV1Schema as rawTriageGetResultV1Schema,
    TriageScanInputV1Schema as rawTriageScanInputV1Schema,
    TriageScanConnectedAccountInputV1Schema as rawTriageScanConnectedAccountInputV1Schema,
    TriageScanCredentialInputV1Schema as rawTriageScanCredentialInputV1Schema,
    TriageScanResultV1Schema as rawTriageScanResultV1Schema,
} from './operations.js';
import {
    TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema as rawTriagePrepareReviewWorkspaceConnectedAccountInputV1Schema,
    TriagePrepareReviewWorkspaceCredentialInputV1Schema as rawTriagePrepareReviewWorkspaceCredentialInputV1Schema,
    TriagePrepareReviewWorkspaceInputV1Schema as rawTriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema as rawTriagePrepareReviewWorkspaceResultV1Schema,
    TriageVerifyReviewWorkspaceInputV1Schema as rawTriageVerifyReviewWorkspaceInputV1Schema,
    TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema as rawTriageVerifyReviewWorkspaceConnectedAccountInputV1Schema,
    TriageVerifyReviewWorkspaceCredentialInputV1Schema as rawTriageVerifyReviewWorkspaceCredentialInputV1Schema,
    TriageVerifyReviewWorkspaceResultV1Schema as rawTriageVerifyReviewWorkspaceResultV1Schema,
} from './workspace.js';
import {
    TriageTaskCreateInputV1Schema as rawTriageTaskCreateInputV1Schema, TriageTaskEditInputV1Schema as rawTriageTaskEditInputV1Schema, TriageTaskTransitionInputV1Schema as rawTriageTaskTransitionInputV1Schema,
    TriageTaskCreateConnectedAccountInputV1Schema as rawTriageTaskCreateConnectedAccountInputV1Schema, TriageTaskEditConnectedAccountInputV1Schema as rawTriageTaskEditConnectedAccountInputV1Schema,
    TriageTaskTransitionConnectedAccountInputV1Schema as rawTriageTaskTransitionConnectedAccountInputV1Schema, TriageTaskWriteResultV1Schema as rawTriageTaskWriteResultV1Schema,
    TriageTaskCreateCredentialInputV1Schema as rawTriageTaskCreateCredentialInputV1Schema, TriageTaskEditCredentialInputV1Schema as rawTriageTaskEditCredentialInputV1Schema, TriageTaskTransitionCredentialInputV1Schema as rawTriageTaskTransitionCredentialInputV1Schema,
} from './tasks.js';
import {
    TriageSourceLinkSessionInputV1Schema as rawTriageSourceLinkSessionInputV1Schema, TriageSourceLinkSessionResultV1Schema as rawTriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksInputV1Schema as rawTriageSourceReadSessionLinksInputV1Schema, TriageSourceReadSessionLinksResultV1Schema as rawTriageSourceReadSessionLinksResultV1Schema,
    TriageSourceLinkSessionConnectedAccountInputV1Schema as rawTriageSourceLinkSessionConnectedAccountInputV1Schema, TriageSourceReadSessionLinksConnectedAccountInputV1Schema as rawTriageSourceReadSessionLinksConnectedAccountInputV1Schema,
    TriageSourceLinkSessionCredentialInputV1Schema as rawTriageSourceLinkSessionCredentialInputV1Schema, TriageSourceReadSessionLinksCredentialInputV1Schema as rawTriageSourceReadSessionLinksCredentialInputV1Schema,
} from './sessionLinks.js';

import type { ProtocolComposableSchema, ProtocolSchemaInput, ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { TriageReadAttentionInputV1Schema, TriageReadAttentionConnectedAccountInputV1Schema, TriageReadAttentionCredentialInputV1Schema, TriageReadAttentionResultV1Schema } from './attention.js';
import { TriageResolveResourceInputV1Schema, TriageResolveResourceConnectedAccountInputV1Schema,
    TriageResolveResourceCredentialInputV1Schema, TriageResolveResourceResultV1Schema } from './resourceLinks.js';

// Name the composed leaves here without copying or replacing their owning parsers.
export interface TriageContributionSourceDescriptorAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceDescriptorV1Schema> {}
export interface TriageContributionSourceDescriptorV1 extends ProtocolSchemaOutput<typeof rawTriageSourceDescriptorV1Schema> {}
const TriageSourceDescriptorV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceDescriptorAuthoredV1>, Readonly<TriageContributionSourceDescriptorV1>> = rawTriageSourceDescriptorV1Schema;
export interface TriageContributionDetailSurfaceInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageDetailSurfaceInputV1Schema> {}
export interface TriageContributionDetailSurfaceInputV1 extends ProtocolSchemaOutput<typeof rawTriageDetailSurfaceInputV1Schema> {}
const TriageDetailSurfaceInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionDetailSurfaceInputAuthoredV1>, Readonly<TriageContributionDetailSurfaceInputV1>> = rawTriageDetailSurfaceInputV1Schema;
export type TriageContributionPullRequestStatusResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriagePullRequestStatusResultV1Schema>;
export type TriageContributionPullRequestStatusResultV1 = ProtocolSchemaOutput<typeof rawTriagePullRequestStatusResultV1Schema>;
const TriagePullRequestStatusResultV1Schema: ProtocolComposableSchema<TriageContributionPullRequestStatusResultAuthoredV1, TriageContributionPullRequestStatusResultV1> = rawTriagePullRequestStatusResultV1Schema;
export type TriageContributionSourceReadFixPullRequestsResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageSourceReadFixPullRequestsResultV1Schema>;
export type TriageContributionSourceReadFixPullRequestsResultV1 = ProtocolSchemaOutput<typeof rawTriageSourceReadFixPullRequestsResultV1Schema>;
const TriageSourceReadFixPullRequestsResultV1Schema: ProtocolComposableSchema<TriageContributionSourceReadFixPullRequestsResultAuthoredV1, TriageContributionSourceReadFixPullRequestsResultV1> = rawTriageSourceReadFixPullRequestsResultV1Schema;
export interface TriageContributionListScopeUnitsInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageListScopeUnitsInputV1Schema> {}
export interface TriageContributionListScopeUnitsInputV1 extends ProtocolSchemaOutput<typeof rawTriageListScopeUnitsInputV1Schema> {}
const TriageListScopeUnitsInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionListScopeUnitsInputAuthoredV1>, Readonly<TriageContributionListScopeUnitsInputV1>> = rawTriageListScopeUnitsInputV1Schema;
export type TriageContributionListScopeUnitsResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageListScopeUnitsResultV1Schema>;
export type TriageContributionListScopeUnitsResultV1 = ProtocolSchemaOutput<typeof rawTriageListScopeUnitsResultV1Schema>;
const TriageListScopeUnitsResultV1Schema: ProtocolComposableSchema<TriageContributionListScopeUnitsResultAuthoredV1, TriageContributionListScopeUnitsResultV1> = rawTriageListScopeUnitsResultV1Schema;
export interface TriageContributionListScopeUnitsConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageListScopeUnitsConnectedAccountInputV1Schema> {}
export interface TriageContributionListScopeUnitsConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageListScopeUnitsConnectedAccountInputV1Schema> {}
const TriageListScopeUnitsConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionListScopeUnitsConnectedAccountInputAuthoredV1>, Readonly<TriageContributionListScopeUnitsConnectedAccountInputV1>> = rawTriageListScopeUnitsConnectedAccountInputV1Schema;
export interface TriageContributionListScopeUnitsCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageListScopeUnitsCredentialInputV1Schema> {}
export interface TriageContributionListScopeUnitsCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageListScopeUnitsCredentialInputV1Schema> {}
const TriageListScopeUnitsCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionListScopeUnitsCredentialInputAuthoredV1>, Readonly<TriageContributionListScopeUnitsCredentialInputV1>> = rawTriageListScopeUnitsCredentialInputV1Schema;
export interface TriageContributionListInstancesInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageListInstancesInputV1Schema> {}
export interface TriageContributionListInstancesInputV1 extends ProtocolSchemaOutput<typeof rawTriageListInstancesInputV1Schema> {}
const TriageListInstancesInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionListInstancesInputAuthoredV1>, Readonly<TriageContributionListInstancesInputV1>> = rawTriageListInstancesInputV1Schema;
export type TriageContributionListInstancesResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageListInstancesResultV1Schema>;
export type TriageContributionListInstancesResultV1 = ProtocolSchemaOutput<typeof rawTriageListInstancesResultV1Schema>;
const TriageListInstancesResultV1Schema: ProtocolComposableSchema<TriageContributionListInstancesResultAuthoredV1, TriageContributionListInstancesResultV1> = rawTriageListInstancesResultV1Schema;
export interface TriageContributionGetConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageGetConnectedAccountInputV1Schema> {}
export interface TriageContributionGetConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageGetConnectedAccountInputV1Schema> {}
const TriageGetConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionGetConnectedAccountInputAuthoredV1>, Readonly<TriageContributionGetConnectedAccountInputV1>> = rawTriageGetConnectedAccountInputV1Schema;
export interface TriageContributionGetCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageGetCredentialInputV1Schema> {}
export interface TriageContributionGetCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageGetCredentialInputV1Schema> {}
const TriageGetCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionGetCredentialInputAuthoredV1>, Readonly<TriageContributionGetCredentialInputV1>> = rawTriageGetCredentialInputV1Schema;
export interface TriageContributionGetInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageGetInputV1Schema> {}
export interface TriageContributionGetInputV1 extends ProtocolSchemaOutput<typeof rawTriageGetInputV1Schema> {}
const TriageGetInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionGetInputAuthoredV1>, Readonly<TriageContributionGetInputV1>> = rawTriageGetInputV1Schema;
export type TriageContributionGetResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageGetResultV1Schema>;
export type TriageContributionGetResultV1 = ProtocolSchemaOutput<typeof rawTriageGetResultV1Schema>;
const TriageGetResultV1Schema: ProtocolComposableSchema<TriageContributionGetResultAuthoredV1, TriageContributionGetResultV1> = rawTriageGetResultV1Schema;
export type TriageContributionScanInputAuthoredV1 = ProtocolSchemaInput<typeof rawTriageScanInputV1Schema>;
export type TriageContributionScanInputV1 = ProtocolSchemaOutput<typeof rawTriageScanInputV1Schema>;
const TriageScanInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionScanInputAuthoredV1>, Readonly<TriageContributionScanInputV1>> = rawTriageScanInputV1Schema;
export type TriageContributionScanConnectedAccountInputAuthoredV1 = ProtocolSchemaInput<typeof rawTriageScanConnectedAccountInputV1Schema>;
export type TriageContributionScanConnectedAccountInputV1 = ProtocolSchemaOutput<typeof rawTriageScanConnectedAccountInputV1Schema>;
const TriageScanConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionScanConnectedAccountInputAuthoredV1>, Readonly<TriageContributionScanConnectedAccountInputV1>> = rawTriageScanConnectedAccountInputV1Schema;
export type TriageContributionScanCredentialInputAuthoredV1 = ProtocolSchemaInput<typeof rawTriageScanCredentialInputV1Schema>;
export type TriageContributionScanCredentialInputV1 = ProtocolSchemaOutput<typeof rawTriageScanCredentialInputV1Schema>;
const TriageScanCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionScanCredentialInputAuthoredV1>, Readonly<TriageContributionScanCredentialInputV1>> = rawTriageScanCredentialInputV1Schema;
export type TriageContributionScanResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageScanResultV1Schema>;
export type TriageContributionScanResultV1 = ProtocolSchemaOutput<typeof rawTriageScanResultV1Schema>;
const TriageScanResultV1Schema: ProtocolComposableSchema<TriageContributionScanResultAuthoredV1, TriageContributionScanResultV1> = rawTriageScanResultV1Schema;
export interface TriageContributionPrepareReviewWorkspaceConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriagePrepareReviewWorkspaceConnectedAccountInputV1Schema> {}
export interface TriageContributionPrepareReviewWorkspaceConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriagePrepareReviewWorkspaceConnectedAccountInputV1Schema> {}
const TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionPrepareReviewWorkspaceConnectedAccountInputAuthoredV1>, Readonly<TriageContributionPrepareReviewWorkspaceConnectedAccountInputV1>> = rawTriagePrepareReviewWorkspaceConnectedAccountInputV1Schema;
export interface TriageContributionPrepareReviewWorkspaceCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriagePrepareReviewWorkspaceCredentialInputV1Schema> {}
export interface TriageContributionPrepareReviewWorkspaceCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriagePrepareReviewWorkspaceCredentialInputV1Schema> {}
const TriagePrepareReviewWorkspaceCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionPrepareReviewWorkspaceCredentialInputAuthoredV1>, Readonly<TriageContributionPrepareReviewWorkspaceCredentialInputV1>> = rawTriagePrepareReviewWorkspaceCredentialInputV1Schema;
export interface TriageContributionPrepareReviewWorkspaceInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriagePrepareReviewWorkspaceInputV1Schema> {}
export interface TriageContributionPrepareReviewWorkspaceInputV1 extends ProtocolSchemaOutput<typeof rawTriagePrepareReviewWorkspaceInputV1Schema> {}
const TriagePrepareReviewWorkspaceInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionPrepareReviewWorkspaceInputAuthoredV1>, Readonly<TriageContributionPrepareReviewWorkspaceInputV1>> = rawTriagePrepareReviewWorkspaceInputV1Schema;
export type TriageContributionPrepareReviewWorkspaceResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriagePrepareReviewWorkspaceResultV1Schema>;
export type TriageContributionPrepareReviewWorkspaceResultV1 = ProtocolSchemaOutput<typeof rawTriagePrepareReviewWorkspaceResultV1Schema>;
const TriagePrepareReviewWorkspaceResultV1Schema: ProtocolComposableSchema<TriageContributionPrepareReviewWorkspaceResultAuthoredV1, TriageContributionPrepareReviewWorkspaceResultV1> = rawTriagePrepareReviewWorkspaceResultV1Schema;
export interface TriageContributionVerifyReviewWorkspaceInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageVerifyReviewWorkspaceInputV1Schema> {}
export interface TriageContributionVerifyReviewWorkspaceInputV1 extends ProtocolSchemaOutput<typeof rawTriageVerifyReviewWorkspaceInputV1Schema> {}
const TriageVerifyReviewWorkspaceInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionVerifyReviewWorkspaceInputAuthoredV1>, Readonly<TriageContributionVerifyReviewWorkspaceInputV1>> = rawTriageVerifyReviewWorkspaceInputV1Schema;
export interface TriageContributionVerifyReviewWorkspaceConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageVerifyReviewWorkspaceConnectedAccountInputV1Schema> {}
export interface TriageContributionVerifyReviewWorkspaceConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageVerifyReviewWorkspaceConnectedAccountInputV1Schema> {}
const TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionVerifyReviewWorkspaceConnectedAccountInputAuthoredV1>, Readonly<TriageContributionVerifyReviewWorkspaceConnectedAccountInputV1>> = rawTriageVerifyReviewWorkspaceConnectedAccountInputV1Schema;
export interface TriageContributionVerifyReviewWorkspaceCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageVerifyReviewWorkspaceCredentialInputV1Schema> {}
export interface TriageContributionVerifyReviewWorkspaceCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageVerifyReviewWorkspaceCredentialInputV1Schema> {}
const TriageVerifyReviewWorkspaceCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionVerifyReviewWorkspaceCredentialInputAuthoredV1>, Readonly<TriageContributionVerifyReviewWorkspaceCredentialInputV1>> = rawTriageVerifyReviewWorkspaceCredentialInputV1Schema;
export type TriageContributionVerifyReviewWorkspaceResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageVerifyReviewWorkspaceResultV1Schema>;
export type TriageContributionVerifyReviewWorkspaceResultV1 = ProtocolSchemaOutput<typeof rawTriageVerifyReviewWorkspaceResultV1Schema>;
const TriageVerifyReviewWorkspaceResultV1Schema: ProtocolComposableSchema<TriageContributionVerifyReviewWorkspaceResultAuthoredV1, TriageContributionVerifyReviewWorkspaceResultV1> = rawTriageVerifyReviewWorkspaceResultV1Schema;
export interface TriageContributionTaskCreateInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskCreateInputV1Schema> {}
export interface TriageContributionTaskCreateInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskCreateInputV1Schema> {}
const TriageTaskCreateInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskCreateInputAuthoredV1>, Readonly<TriageContributionTaskCreateInputV1>> = rawTriageTaskCreateInputV1Schema;
export interface TriageContributionTaskEditInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskEditInputV1Schema> {}
export interface TriageContributionTaskEditInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskEditInputV1Schema> {}
const TriageTaskEditInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskEditInputAuthoredV1>, Readonly<TriageContributionTaskEditInputV1>> = rawTriageTaskEditInputV1Schema;
export interface TriageContributionTaskTransitionInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskTransitionInputV1Schema> {}
export interface TriageContributionTaskTransitionInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskTransitionInputV1Schema> {}
const TriageTaskTransitionInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskTransitionInputAuthoredV1>, Readonly<TriageContributionTaskTransitionInputV1>> = rawTriageTaskTransitionInputV1Schema;
export interface TriageContributionTaskCreateConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskCreateConnectedAccountInputV1Schema> {}
export interface TriageContributionTaskCreateConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskCreateConnectedAccountInputV1Schema> {}
const TriageTaskCreateConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskCreateConnectedAccountInputAuthoredV1>, Readonly<TriageContributionTaskCreateConnectedAccountInputV1>> = rawTriageTaskCreateConnectedAccountInputV1Schema;
export interface TriageContributionTaskEditConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskEditConnectedAccountInputV1Schema> {}
export interface TriageContributionTaskEditConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskEditConnectedAccountInputV1Schema> {}
const TriageTaskEditConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskEditConnectedAccountInputAuthoredV1>, Readonly<TriageContributionTaskEditConnectedAccountInputV1>> = rawTriageTaskEditConnectedAccountInputV1Schema;
export interface TriageContributionTaskTransitionConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskTransitionConnectedAccountInputV1Schema> {}
export interface TriageContributionTaskTransitionConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskTransitionConnectedAccountInputV1Schema> {}
const TriageTaskTransitionConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskTransitionConnectedAccountInputAuthoredV1>, Readonly<TriageContributionTaskTransitionConnectedAccountInputV1>> = rawTriageTaskTransitionConnectedAccountInputV1Schema;
export type TriageContributionTaskWriteResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageTaskWriteResultV1Schema>;
export type TriageContributionTaskWriteResultV1 = ProtocolSchemaOutput<typeof rawTriageTaskWriteResultV1Schema>;
const TriageTaskWriteResultV1Schema: ProtocolComposableSchema<TriageContributionTaskWriteResultAuthoredV1, TriageContributionTaskWriteResultV1> = rawTriageTaskWriteResultV1Schema;
export interface TriageContributionTaskCreateCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskCreateCredentialInputV1Schema> {}
export interface TriageContributionTaskCreateCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskCreateCredentialInputV1Schema> {}
const TriageTaskCreateCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskCreateCredentialInputAuthoredV1>, Readonly<TriageContributionTaskCreateCredentialInputV1>> = rawTriageTaskCreateCredentialInputV1Schema;
export interface TriageContributionTaskEditCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskEditCredentialInputV1Schema> {}
export interface TriageContributionTaskEditCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskEditCredentialInputV1Schema> {}
const TriageTaskEditCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskEditCredentialInputAuthoredV1>, Readonly<TriageContributionTaskEditCredentialInputV1>> = rawTriageTaskEditCredentialInputV1Schema;
export interface TriageContributionTaskTransitionCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageTaskTransitionCredentialInputV1Schema> {}
export interface TriageContributionTaskTransitionCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageTaskTransitionCredentialInputV1Schema> {}
const TriageTaskTransitionCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionTaskTransitionCredentialInputAuthoredV1>, Readonly<TriageContributionTaskTransitionCredentialInputV1>> = rawTriageTaskTransitionCredentialInputV1Schema;
export interface TriageContributionSourceLinkSessionInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceLinkSessionInputV1Schema> {}
export interface TriageContributionSourceLinkSessionInputV1 extends ProtocolSchemaOutput<typeof rawTriageSourceLinkSessionInputV1Schema> {}
const TriageSourceLinkSessionInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceLinkSessionInputAuthoredV1>, Readonly<TriageContributionSourceLinkSessionInputV1>> = rawTriageSourceLinkSessionInputV1Schema;
export type TriageContributionSourceLinkSessionResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageSourceLinkSessionResultV1Schema>;
export type TriageContributionSourceLinkSessionResultV1 = ProtocolSchemaOutput<typeof rawTriageSourceLinkSessionResultV1Schema>;
const TriageSourceLinkSessionResultV1Schema: ProtocolComposableSchema<TriageContributionSourceLinkSessionResultAuthoredV1, TriageContributionSourceLinkSessionResultV1> = rawTriageSourceLinkSessionResultV1Schema;
export interface TriageContributionSourceReadSessionLinksInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceReadSessionLinksInputV1Schema> {}
export interface TriageContributionSourceReadSessionLinksInputV1 extends ProtocolSchemaOutput<typeof rawTriageSourceReadSessionLinksInputV1Schema> {}
const TriageSourceReadSessionLinksInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceReadSessionLinksInputAuthoredV1>, Readonly<TriageContributionSourceReadSessionLinksInputV1>> = rawTriageSourceReadSessionLinksInputV1Schema;
export type TriageContributionSourceReadSessionLinksResultAuthoredV1 = ProtocolSchemaInput<typeof rawTriageSourceReadSessionLinksResultV1Schema>;
export type TriageContributionSourceReadSessionLinksResultV1 = ProtocolSchemaOutput<typeof rawTriageSourceReadSessionLinksResultV1Schema>;
const TriageSourceReadSessionLinksResultV1Schema: ProtocolComposableSchema<TriageContributionSourceReadSessionLinksResultAuthoredV1, TriageContributionSourceReadSessionLinksResultV1> = rawTriageSourceReadSessionLinksResultV1Schema;
export interface TriageContributionSourceLinkSessionConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceLinkSessionConnectedAccountInputV1Schema> {}
export interface TriageContributionSourceLinkSessionConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageSourceLinkSessionConnectedAccountInputV1Schema> {}
const TriageSourceLinkSessionConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceLinkSessionConnectedAccountInputAuthoredV1>, Readonly<TriageContributionSourceLinkSessionConnectedAccountInputV1>> = rawTriageSourceLinkSessionConnectedAccountInputV1Schema;
export interface TriageContributionSourceReadSessionLinksConnectedAccountInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceReadSessionLinksConnectedAccountInputV1Schema> {}
export interface TriageContributionSourceReadSessionLinksConnectedAccountInputV1 extends ProtocolSchemaOutput<typeof rawTriageSourceReadSessionLinksConnectedAccountInputV1Schema> {}
const TriageSourceReadSessionLinksConnectedAccountInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceReadSessionLinksConnectedAccountInputAuthoredV1>, Readonly<TriageContributionSourceReadSessionLinksConnectedAccountInputV1>> = rawTriageSourceReadSessionLinksConnectedAccountInputV1Schema;
export interface TriageContributionSourceLinkSessionCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceLinkSessionCredentialInputV1Schema> {}
export interface TriageContributionSourceLinkSessionCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageSourceLinkSessionCredentialInputV1Schema> {}
const TriageSourceLinkSessionCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceLinkSessionCredentialInputAuthoredV1>, Readonly<TriageContributionSourceLinkSessionCredentialInputV1>> = rawTriageSourceLinkSessionCredentialInputV1Schema;
export interface TriageContributionSourceReadSessionLinksCredentialInputAuthoredV1 extends ProtocolSchemaInput<typeof rawTriageSourceReadSessionLinksCredentialInputV1Schema> {}
export interface TriageContributionSourceReadSessionLinksCredentialInputV1 extends ProtocolSchemaOutput<typeof rawTriageSourceReadSessionLinksCredentialInputV1Schema> {}
const TriageSourceReadSessionLinksCredentialInputV1Schema: ProtocolComposableSchema<Readonly<TriageContributionSourceReadSessionLinksCredentialInputAuthoredV1>, Readonly<TriageContributionSourceReadSessionLinksCredentialInputV1>> = rawTriageSourceReadSessionLinksCredentialInputV1Schema;

/**
 * The V1 source role contract.
 *
 * The provider-read roles, including optional PR status, are `safe`; `prepareReviewWorkspace` is the one
 * optional source-owned local materialization and is therefore `writesLocal`.
 * Task writes are optional declared roles bound to ordinary source Actions.
 * The source keeps authorization and settlement; other native writes retain
 * their exact named Actions. There is no arbitrary verb/payload operation.
 */
export const TriageSourcesContributionProtocolV1 = defineContributionProtocol({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    descriptor: TriageSourceDescriptorV1Schema,
    operations: {
        listCreationPlaces: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskCreationPlacesInputV1Schema },
            resultSchema: TriageTaskCreationPlacesResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe' },
        },
        resolveResource: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageResolveResourceInputV1Schema },
            resultSchema: TriageResolveResourceResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        readAttention: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageReadAttentionInputV1Schema },
            resultSchema: TriageReadAttentionResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        listScopeUnits: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageListScopeUnitsInputV1Schema },
            resultSchema: TriageListScopeUnitsResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe' },
        },
        linkSession: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageSourceLinkSessionInputV1Schema },
            resultSchema: TriageSourceLinkSessionResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe' },
        },
        readSessionLinks: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageSourceReadSessionLinksInputV1Schema },
            resultSchema: TriageSourceReadSessionLinksResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        create: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskCreateInputV1Schema },
            resultSchema: TriageTaskWriteResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        edit: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskEditInputV1Schema },
            resultSchema: TriageTaskWriteResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        transition: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskTransitionInputV1Schema },
            resultSchema: TriageTaskWriteResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        listInstances: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageListInstancesInputV1Schema },
            resultSchema: TriageListInstancesResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe' },
        },
        scan: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageScanInputV1Schema },
            resultSchema: TriageScanResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        get: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriageGetResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        readPullRequestStatus: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriagePullRequestStatusResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        readFixPullRequests: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriageSourceReadFixPullRequestsResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        prepareReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriagePrepareReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriagePrepareReviewWorkspaceResultV1Schema,
            // Prepared New Session authoring invokes this role from mounted UI.
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'writesLocal' },
        },
        verifyReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriageVerifyReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriageVerifyReviewWorkspaceResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
    },
    surfaces: {
        detail: {
            required: true,
            inputSchema: TriageDetailSurfaceInputV1Schema,
            presentation: 'fill',
        },
    },
});

/** Exact V1 Action inputs for sources that support connected Accounts only. */
export const TriageSourceConnectedAccountInputsV1 = {
    listCreationPlaces: TriageTaskCreationPlacesConnectedAccountInputV1Schema,
    resolveResource: TriageResolveResourceConnectedAccountInputV1Schema,
    readAttention: TriageReadAttentionConnectedAccountInputV1Schema,
    listScopeUnits: TriageListScopeUnitsConnectedAccountInputV1Schema,
    linkSession: TriageSourceLinkSessionConnectedAccountInputV1Schema,
    readSessionLinks: TriageSourceReadSessionLinksConnectedAccountInputV1Schema,
    create: TriageTaskCreateConnectedAccountInputV1Schema,
    edit: TriageTaskEditConnectedAccountInputV1Schema,
    transition: TriageTaskTransitionConnectedAccountInputV1Schema,
    listInstances: TriageListInstancesInputV1Schema,
    scan: TriageScanConnectedAccountInputV1Schema,
    get: TriageGetConnectedAccountInputV1Schema,
    readPullRequestStatus: TriageGetConnectedAccountInputV1Schema,
    readFixPullRequests: TriageGetConnectedAccountInputV1Schema,
    prepareReviewWorkspace: TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema,
    verifyReviewWorkspace: TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema,
} as const satisfies Record<keyof typeof TriageSourcesContributionProtocolV1.operations, unknown>;

/** Exact inputs for a source that materializes connected or machine-native credentials. */
export const TriageSourceCredentialInputsV1 = {
    listCreationPlaces: TriageTaskCreationPlacesCredentialInputV1Schema,
    resolveResource: TriageResolveResourceCredentialInputV1Schema,
    readAttention: TriageReadAttentionCredentialInputV1Schema,
    listScopeUnits: TriageListScopeUnitsCredentialInputV1Schema,
    create: TriageTaskCreateCredentialInputV1Schema,
    edit: TriageTaskEditCredentialInputV1Schema,
    transition: TriageTaskTransitionCredentialInputV1Schema,
    linkSession: TriageSourceLinkSessionCredentialInputV1Schema,
    readSessionLinks: TriageSourceReadSessionLinksCredentialInputV1Schema,
    listInstances: TriageListInstancesInputV1Schema,
    scan: TriageScanCredentialInputV1Schema,
    get: TriageGetCredentialInputV1Schema,
    readPullRequestStatus: TriageGetCredentialInputV1Schema,
    readFixPullRequests: TriageGetCredentialInputV1Schema,
    prepareReviewWorkspace: TriagePrepareReviewWorkspaceCredentialInputV1Schema,
    verifyReviewWorkspace: TriageVerifyReviewWorkspaceCredentialInputV1Schema,
} as const satisfies Record<keyof typeof TriageSourcesContributionProtocolV1.operations, unknown>;

/** The target-owned `sources` point admits one V1 contribution per source plugin. */
export const TriageSourcesContributionPointV1 = defineContributionPoint(
    [TriageSourcesContributionProtocolV1],
    { maxContributionsPerContributor: 1 },
);
