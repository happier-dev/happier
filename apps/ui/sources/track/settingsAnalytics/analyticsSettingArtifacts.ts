import type { SettingArtifacts} from '@happier-dev/protocol/settings/registry/buildSettingArtifacts';
import type { SettingDefinitionMap } from '@happier-dev/protocol/settings/registry/settingDefinition';

/**
 * The subset of catalog artifacts that analytics needs. It intentionally excludes schema shape
 * and defaults so a presentation projection cannot become a settings persistence owner.
 */
export type AnalyticsSettingArtifacts<TDefinitions extends SettingDefinitionMap> = Pick<
    SettingArtifacts<TDefinitions>,
    | 'definitions'
    | 'trackedCurrentStateDefinitions'
    | 'trackedChangeDefinitions'
    | 'trackedDerivedDefinitions'
>;
