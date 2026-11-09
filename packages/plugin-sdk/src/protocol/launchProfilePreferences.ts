import {
    LaunchProfilePlacementPreferenceV1ProtocolSchema,
    LaunchProfileCheckoutPreferenceV1ProtocolSchema,
    resolveLaunchProfilePlacementDirectoryIntentV1,
} from '@happier-dev/protocol/profiles/v2/schema';
import type { PluginActionInputById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

type Profile = PluginActionInputById['launch_profiles.create']['profile'];
export type LaunchProfilePlacementPreferenceV1 = NonNullable<Profile['placement']>;
export type LaunchProfileCheckoutPreferenceV1 = NonNullable<Profile['checkout']>;
export type SessionDirectoryIntentV1 = NonNullable<ReturnType<typeof resolveLaunchProfilePlacementDirectoryIntentV1>>;
export { resolveLaunchProfilePlacementDirectoryIntentV1 };

/** Neutral projections of the Profile owner's preference grammar. */
export const ProtocolLaunchProfilePlacementPreferenceV1Schema: ProtocolComposableSchema<NonNullable<Profile['placement']>> =
    LaunchProfilePlacementPreferenceV1ProtocolSchema;
export const ProtocolLaunchProfileCheckoutPreferenceV1Schema: ProtocolComposableSchema<NonNullable<Profile['checkout']>> =
    LaunchProfileCheckoutPreferenceV1ProtocolSchema;
