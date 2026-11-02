/** @moduleRealm any */
import * as canonical from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { ProtocolComposableSchema, ProtocolJsonValue, PluginJsonSchema } from './protocol/protocolFacade.js';
import { projectProtocolValue } from './protocol/projectProtocolValue.js';
import type { PluginContributionRef } from './identity.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import type { MachineRecipeV1 } from './machineSetup.js';

export type AccessProviderRefV1 = Readonly<{ kind: 'builtin'; id: string }> | PluginContributionRef;
export type AccessCredentialPurposeRefV1 = Readonly<{ purpose: string; credentialRef:
  | Readonly<{ kind: 'savedSecret'; ref: string; resourceRevision: number }>
  | Readonly<{ kind: 'connectedAccount'; account: Readonly<{ service: PluginContributionRef; accountId: string }> }> }>;
export type AccessProviderSelectionV1 = Readonly<{ provider: AccessProviderRefV1; config: ProtocolJsonValue; credentialRefs: readonly AccessCredentialPurposeRefV1[] }>;
export type AccessProviderRoleV1 = 'inspect' | 'configure' | 'disable' | 'join' | 'leave';
export type AccessProviderRouteV1 = Readonly<{ ownerId: string; hostname: string; httpsPort: number; path: string; upstream: string }>;
export type MachinePrivateNetworkObservationV1 = Readonly<{
  provider: AccessProviderRefV1; networkIdentity: string | null; displayName: string | null; dnsName: string | null;
  addresses: readonly string[]; state: 'ready' | 'stopped' | 'needsAuth' | 'unavailable' | 'unknown';
  interfaceName: string | null; sourceRanges: readonly string[]; magicDnsEnabled: boolean | null;
}>;
export type AccessProviderRoleResultV1 =
  | Readonly<{ kind: 'confirmed'; facts: Readonly<{ state: MachinePrivateNetworkObservationV1['state']; privateNetwork?: MachinePrivateNetworkObservationV1; publicUrl?: string }> }>
  | Readonly<{ kind: 'refused' | 'unknown'; code: string }>;
export type AccessProviderContributionV1 = Readonly<{
  id: string; title: PluginLocalizedStringV2; icon: string; description?: PluginLocalizedStringV2; schemaVersion: 1;
  targets: readonly ('machine' | 'domainRoute' | 'homeRelay')[];
  capabilities: readonly ('management' | 'ingress' | 'privateNetwork')[];
  /** Nonsecret configuration; credential purposes carry opaque references separately. */
  configSchema: PluginJsonSchema; exposure: 'local' | 'lan' | 'privateNetwork' | 'public';
  https?: Readonly<{ hostname: 'providerAssigned' | 'custom' | 'either'; ports: readonly number[]; paths: boolean }>;
  inboundPorts: readonly Readonly<{ port: number; protocol: 'tcp' | 'udp'; exposure: 'public' | 'privateNetwork' | 'loopback' }>[];
  credentialPurposes: readonly Readonly<{ purpose: string; required: boolean }>[];
  install?: Readonly<{ kind: 'recipe'; ref: Readonly<{ pluginId: string; recipeId: string; revision: string }> }>
    | Readonly<{ kind: 'managedDependency' | 'systemTool'; id: string | PluginContributionRef }>;
  membership?: Readonly<{ join: MachineRecipeV1; leave: MachineRecipeV1 }>;
  actions: Readonly<{ inspect: string; configure?: string; disable?: string; join?: string; leave?: string }>;
}>;
export type AccessProviderAuthorDefinitionV1 = Omit<AccessProviderContributionV1, 'id'>;
export type AccessProviderRoleInputV1<TConfig = ProtocolJsonValue> = Readonly<{
  machineId: string; config: TConfig; credentialRefs: readonly AccessCredentialPurposeRefV1[]; route?: AccessProviderRouteV1;
}>;
export const AccessProviderRefV1Schema: ProtocolComposableSchema<AccessProviderRefV1> = /* @__PURE__ */ projectProtocolValue(canonical.AccessProviderRefProtocolV1Schema);
export const AccessProviderSelectionV1Schema: ProtocolComposableSchema<AccessProviderSelectionV1> = /* @__PURE__ */ projectProtocolValue(canonical.AccessProviderSelectionProtocolV1Schema);
export const AccessProviderRoleResultV1Schema: ProtocolComposableSchema<AccessProviderRoleResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.AccessProviderRoleResultV1Schema);
export const accessProviderRefsEqualV1: (left: AccessProviderRefV1, right: AccessProviderRefV1) => boolean = /* @__PURE__ */ projectProtocolValue(canonical.accessProviderRefsEqualV1);
export const defineAccessProviderSchemas: <CI, CO>(schemas: Readonly<{ config: ProtocolComposableSchema<CI, CO> }>) => Readonly<{
  inspectInput: ProtocolComposableSchema<AccessProviderRoleInputV1<CI>, AccessProviderRoleInputV1<CO>>;
  configureInput: ProtocolComposableSchema<AccessProviderRoleInputV1<CI> & Readonly<{ route: AccessProviderRouteV1 }>, AccessProviderRoleInputV1<CO> & Readonly<{ route: AccessProviderRouteV1 }>>;
  disableInput: ProtocolComposableSchema<AccessProviderRoleInputV1<CI> & Readonly<{ route: AccessProviderRouteV1 }>, AccessProviderRoleInputV1<CO> & Readonly<{ route: AccessProviderRouteV1 }>>;
  joinInput: ProtocolComposableSchema<AccessProviderRoleInputV1<CI> & Readonly<{ setupCredentialFile?: string }>, AccessProviderRoleInputV1<CO> & Readonly<{ setupCredentialFile?: string }>>;
  leaveInput: ProtocolComposableSchema<AccessProviderRoleInputV1<CI>, AccessProviderRoleInputV1<CO>>;
  result: ProtocolComposableSchema<AccessProviderRoleResultV1>;
}> = /* @__PURE__ */ projectProtocolValue(canonical.defineAccessProviderSchemas);
