import { expect, expectTypeOf, it } from 'vitest';
import type { DeploymentTargetContributionV1 as CanonicalDeploymentTargetContributionV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { MachineProvisionerContributionV1 as CanonicalMachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { PluginDeclarativeNodeV2Schema as canonicalNodeSchema, type PluginDeclarativeNodeV2 as CanonicalPluginDeclarativeNodeV2 } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import type { SessionSpawnNewInputV2 as CanonicalSessionSpawnNewInputV2, SessionServerStartSpawnDraftV1 as CanonicalSessionServerStartSpawnDraftV1, SessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ConnectedAccountEstablishedRuntime } from '@happier-dev/cli-common/connectedAccounts';
import type { HttpService as CanonicalHttpService } from '@happier-dev/cli-common/plugins/http/contracts';

import type { ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime } from './connectedAccounts.js';
import type { DeploymentTargetContributionV1 } from './deploymentTargets.js';
import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { HttpService } from './services/io.js';
import type { SessionSpawnNewInputV2, SessionServerStartSpawnDraftV1 } from './sessions/authoring.js';
import type { PluginActionInputById } from './actions/actionTypeMap.generated.js';
import type { MachineProvisionerContributionV1 } from './machineProvisioners.js';
import type { PluginDeclarativeNodeV2, PluginLocalizedStringV2 } from './manifest.js';
import type { ScmHostingProviderRef as ProtocolScmHostingProviderRef } from './protocol/hostingRepositoryIdentity.js';
import type { ProtocolSchemaOutput, PluginJsonSchema } from './protocol/protocolFacade.js';
import type { ScmHostingProviderRef } from './scm/hostingProvider.js';
import { PluginDeclarativeNodeV2Schema } from './ui/declarativeData.js';

type NodeFieldsByKind<T extends { kind: string }> = {
    [K in T['kind']]: keyof Extract<T, { kind: K }>;
};

it('preserves the canonical JSON schema and localized text shapes', () => {
    expectTypeOf<PluginJsonSchema>().toEqualTypeOf<CanonicalDeploymentTargetContributionV1['targetSchema']>();
    expectTypeOf<PluginLocalizedStringV2>().toEqualTypeOf<CanonicalDeploymentTargetContributionV1['title']>();
});

it('preserves the complete deployment declaration while naming SDK-local types', () => {
    expectTypeOf<DeploymentTargetContributionV1>()
        .toEqualTypeOf<ReadonlyAuthorDeclaration<CanonicalDeploymentTargetContributionV1>>();
});

it('preserves the selected Account and HTTP methods without publishing private service bases', () => {
    expectTypeOf<NonNullable<ConnectedAccountPortableRuntime['materialize']>>()
        .toEqualTypeOf<ConnectedAccountEstablishedRuntime<ConnectedAccountPortableReadContext>['materialize']>();
    expectTypeOf<HttpService>().toEqualTypeOf<Pick<CanonicalHttpService, 'request' | 'openWebSocket'>>();
});

it('keeps retention and repository identity projections equal to their existing owners', () => {
    expectTypeOf<MachineProvisionerContributionV1['retention']['guestLocalStop']>()
        .toEqualTypeOf<CanonicalMachineProvisionerContributionV1['retention']['guestLocalStop']>();
    expectTypeOf<ProtocolScmHostingProviderRef>().toEqualTypeOf<ScmHostingProviderRef>();
});

it('preserves runtime Session birth and draft contracts separately from public Action input', () => {
    expectTypeOf<CanonicalSessionSpawnNewInputV2>().toMatchTypeOf<SessionSpawnNewInputV2>();
    expectTypeOf<CanonicalSessionServerStartSpawnDraftV1>().toMatchTypeOf<SessionServerStartSpawnDraftV1>();
    expectTypeOf<keyof SessionSpawnNewInputV2>().toEqualTypeOf<keyof CanonicalSessionSpawnNewInputV2>();
    expectTypeOf<keyof SessionServerStartSpawnDraftV1>().toEqualTypeOf<keyof CanonicalSessionServerStartSpawnDraftV1>();
    expectTypeOf<SessionSpawnNewInputV2['organizationPlacement']>()
        .toEqualTypeOf<CanonicalSessionSpawnNewInputV2['organizationPlacement']>();
    expectTypeOf<SessionServerStartSpawnDraftV1['organizationPlacement']>()
        .toEqualTypeOf<CanonicalSessionServerStartSpawnDraftV1['organizationPlacement']>();
    expectTypeOf<PluginActionInputById['session.spawn_new']['organizationPlacement']>()
        .toEqualTypeOf<SessionSpawnNewActionInputV2['organizationPlacement']>();
    expectTypeOf<'observeSessionCommit' | 'authoringOrigin'>()
        .exclude<keyof SessionServerStartSpawnDraftV1>().toEqualTypeOf<'observeSessionCommit' | 'authoringOrigin'>();
});

it('publishes the canonical UI parser with its existing public DTO result', () => {
    expectTypeOf<ProtocolSchemaOutput<typeof PluginDeclarativeNodeV2Schema>>()
        .toEqualTypeOf<PluginDeclarativeNodeV2>();
    expectTypeOf<PluginDeclarativeNodeV2>().toMatchTypeOf<CanonicalPluginDeclarativeNodeV2>();
    expectTypeOf<CanonicalPluginDeclarativeNodeV2>().toMatchTypeOf<PluginDeclarativeNodeV2>();
    expectTypeOf<NodeFieldsByKind<PluginDeclarativeNodeV2>>()
        .toEqualTypeOf<NodeFieldsByKind<CanonicalPluginDeclarativeNodeV2>>();
    expect(PluginDeclarativeNodeV2Schema).toBe(canonicalNodeSchema);
    expect(PluginDeclarativeNodeV2Schema.parse({ kind: 'stack', children: [] }))
        .toEqual({ kind: 'stack', children: [] });
    expect(PluginDeclarativeNodeV2Schema.safeParse({ kind: 'unknown' }).success).toBe(false);
});
