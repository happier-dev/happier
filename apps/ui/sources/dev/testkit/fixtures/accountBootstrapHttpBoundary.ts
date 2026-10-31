import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { AccountPetListResponseV1Schema } from '@happier-dev/protocol/pets/accountLibrary';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture } from './projectAccountRows';
import { DiscussionAccountEncryptionInventoryV1Schema } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { SESSION_FOLLOW_RULES_ROUTE_V1, ListSessionFollowRulesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigListResponseV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustListResponseV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRowsListResponseV1Schema, ProfileReferenceGuardReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { AccountSettingsV2HistoryListResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { AutomationDefinitionListResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { FeedResponseSchema } from '@/sync/domains/social/feedTypes';
import { CHANGES_AFTER_CURSOR_HTTP_HEADER, ChangesResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';


/** Explicit empty-Account fixtures only; callers resolve the Home and apply their overrides first. */
export function createEmptyAccountBootstrapHttpResponse(path: string, init?: RequestInit): Response | null {
    const pathname = path.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
        if (pathname === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
        if (pathname === '/v2/changes') {
            const afterHeader = new Headers(init?.headers).get(CHANGES_AFTER_CURSOR_HTTP_HEADER);
            return Response.json(ChangesResponseSchema.parse({ changes: [], nextCursor: 0 }), {
                ...(afterHeader === null ? {} : { headers: { [CHANGES_AFTER_CURSOR_HTTP_HEADER]: afterHeader } }),
            });
        }
        if (pathname === '/v1/machines') return Response.json([] satisfies FetchedMachineRow[]);
        if (pathname === '/v3/automations') return Response.json(AutomationDefinitionListResponseSchema.parse({ automations: [], nextCursor: null }));
        if (pathname === '/v1/feed') return Response.json(FeedResponseSchema.parse({ items: [], hasMore: false }));
        if (pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
        if (pathname === '/v2/sessions' || pathname === '/v2/sessions/active') {
            return Response.json(V2SessionListResponseSchema.parse({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            }));
        }
        if (pathname === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
        if (pathname === '/v2/session-organization') {
            return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
                pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } }));
        }
        if (pathname === '/v1/account/pets') {
            return Response.json(AccountPetListResponseV1Schema.parse({ ok: true, pets: [] }));
        }
    }
    if (method === 'POST') {
        if (pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
        if (pathname === '/v2/sessions/query') {
            return Response.json(SessionListQueryResponseV1Schema.parse({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            }));
        }
        if (pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({
                availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [],
            }));
        }
        if (pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }));
        }
    }
    return null;
}

/** Empty conversion census with initialized empty catalogs; no retained-source initialization is needed. */
export function createEmptyAccountMigrationCensusHttpResponse(path: string, init?: RequestInit): Response | null {
    const pathname = path.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
        return Response.json(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }));
    }
    if (method === 'POST' && pathname === `${PROJECT_TRUST_ROUTE_V1}/list`) {
        return Response.json(ProjectTrustListResponseV1Schema.parse({ rows: [] }));
    }
    if (method !== 'GET') return null;
    if (pathname === '/v1/account/encryption/migrate/discussions/inventory') {
        return Response.json(DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [] }));
    }
    if (pathname === SESSION_FOLLOW_RULES_ROUTE_V1) return Response.json(ListSessionFollowRulesResponseV1Schema.parse({ rules: [] }));
    if (pathname === WORKSPACE_EXECUTION_CONFIG_ROUTE_V1) return Response.json(WorkspaceExecutionConfigListResponseV1Schema.parse({ rows: [] }));
    if (pathname === PROFILE_ROWS_ROUTE_V1) return Response.json(ProfileRowsListResponseV1Schema.parse({
        status: 'listed', rows: [], nextCursor: null, complete: true,
        referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [],
    }));
    if (pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json(ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 'absent' }));
    if (pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json(ProfileTransferRowReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json(PromptLibraryRowsListResponseV1Schema.parse({
        status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: null })),
    }));
    if (pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return Response.json(ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
    if (pathname === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return Response.json(McpServerCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations` || pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
        return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
    }
    if (pathname === REMOTE_HOST_ROWS_ROUTE_V1) return Response.json(RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === NOTIFICATION_CHANNELS_ROUTE_V1) return Response.json(NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'absent' }));
    if (pathname === '/v2/account/settings/history') return Response.json(AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: [] }));
    return null;
}
