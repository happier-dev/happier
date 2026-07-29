import type {
  ConnectedAccountPurposeDeclarationV1,
  ConnectedAccountRequestAuthUseV1,
  ManagedProviderEndpointSecurityFactsV1,
  PluginContributionIdentityV1,
  ProviderWireProtocol,
  QualifiedConnectedAccountPurposeV1,
  ProviderManagedCatalogSourceIdentityV1,
} from '@happier-dev/protocol';
import type {
  ExecOutputTeeV1,
} from '@/plugins/runtime/exec/privateContract';

export type ManagedProviderEndpointDeclarationV1 =
  ManagedProviderEndpointSecurityFactsV1;

export type ResolvedConnectedAccountPurposeDeclarationV1 = Readonly<
  Omit<ConnectedAccountPurposeDeclarationV1, 'service'> & {
    service: PluginContributionIdentityV1;
  }
>;

export type ResolvedFirstPartyManagedProviderFacet = Readonly<{
  managedEndpoint: ManagedProviderEndpointDeclarationV1;
  connectedAccounts: readonly ResolvedConnectedAccountPurposeDeclarationV1[];
  requestAuthUses: readonly ConnectedAccountRequestAuthUseV1[];
}>;

export type ManagedProviderPrivateFileOperations = Readonly<{
  writeExclusive: (input: Readonly<{
    path: string;
    contents: string;
  }>) => Promise<void>;
  remove: (path: string) => Promise<void>;
}>;

export type ManagedProviderRuntimeAdapterInput = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  wrapperBuildVersion: string;
  downstreamBearer: string;
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  protocols: readonly ProviderWireProtocol[];
  modelListEnabled: boolean;
  requestAuth: Readonly<{
    capabilityPath: string;
  }>;
}>;

export type ManagedProviderRuntimeAdapterPreparation = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  privateConfigPath: string;
  expectedReadiness: Readonly<{
    contractVersion: string;
    sdkVersion: string;
  }>;
  prepared: Readonly<{
    downstreamBearer: string;
    protocols: readonly ProviderWireProtocol[];
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    readiness: Readonly<{
      outputTee: ExecOutputTeeV1;
      wait: (signal?: AbortSignal) => Promise<Readonly<{
        contractVersion: string;
        sdkVersion: string;
        protocols: readonly ProviderWireProtocol[];
        purposes: readonly QualifiedConnectedAccountPurposeV1[];
      }>>;
    }>;
  }>;
  cleanup: () => Promise<void>;
}>;

export type ManagedProviderRuntimeRecoveryHealthIdentity = Readonly<{
  v: 1;
  contractVersion: string;
  sdkVersion: string;
  wrapperBuildVersion: string;
  protocols: readonly ProviderWireProtocol[];
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  modelListEnabled: boolean;
  materializationId: string;
}>;

type ManagedProviderRuntimeRecoveryCapabilityV1 =
  | Readonly<{
      inspectRecovery?: never;
      verifyRecoveryHealth?: never;
    }>
  | Readonly<{
      inspectRecovery: (
        input: Readonly<{
          materializedRootDir: string;
          materializationId: string;
          capabilityPath: string;
          purposes: readonly QualifiedConnectedAccountPurposeV1[];
          protocols: readonly ProviderWireProtocol[];
          modelListEnabled: boolean;
        }>,
        privateFiles: Readonly<{
          read: (path: string) => Promise<string>;
        }>,
      ) => Promise<Readonly<{
        privateConfigPath: string;
        capabilityPath: string;
        expectedHealth: ManagedProviderRuntimeRecoveryHealthIdentity;
      }> | null>;
      verifyRecoveryHealth: (
        contents: string,
        expected: ManagedProviderRuntimeRecoveryHealthIdentity,
      ) => boolean;
    }>;

export type ManagedProviderRuntimeAdapterV1 = Readonly<{
  v: 1;
  catalogSource: ProviderManagedCatalogSourceIdentityV1;
  prepare: (
    input: ManagedProviderRuntimeAdapterInput,
    privateFiles: ManagedProviderPrivateFileOperations,
  ) => Promise<ManagedProviderRuntimeAdapterPreparation>;
  resolveAgentEndpoint: (input: Readonly<{
    host: string;
    port: number;
    protocol: ProviderWireProtocol;
    endpointTemplateId: string;
  }>) => string;
}> & ManagedProviderRuntimeRecoveryCapabilityV1;
