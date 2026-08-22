import type {
  PluginContributionIntrospectionPresentationV1,
  PluginContributionLifecycleRecordV1,
  PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';

export type PluginContributionIntrospectionCandidate = Readonly<{
  pluginId: string;
  pluginVersion: string;
  source: PluginDiagnosticRecordV1['plugin']['source'];
  family: string;
  runtimeRegistrationHost?: 'daemon' | 'client' | null;
  runtimeRegistrationFamily?: string;
  identity:
    | Readonly<{ kind: 'localId'; localId: string }>
    | Readonly<{ kind: 'locale'; locale: string }>
    | Readonly<{ kind: 'delegatedDomain'; domainId: string }>;
  registration: PluginContributionLifecycleRecordV1['registration']['requirement'];
  consumer: string;
  platforms: readonly ('cli' | 'web' | 'ios' | 'android' | 'desktop')[];
  /** Family-owned static display facts carried with lifecycle evidence. */
  presentation?: PluginContributionIntrospectionPresentationV1;
}>;

export type PluginContributionRuntimeFacts = Readonly<{
  registration: PluginContributionLifecycleRecordV1['registration'];
  activation: PluginContributionLifecycleRecordV1['activation'];
  projection: PluginContributionLifecycleRecordV1['projection'];
}>;
