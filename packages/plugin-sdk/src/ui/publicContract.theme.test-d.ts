import type { PluginUiHostApiSurfaceContextV1 as ProtocolSurfaceContext } from '@happier-dev/protocol/plugins/ui/client';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

type Assert<Condition extends true> = Condition;
type IsEqual<Left, Right> = (
    <T>() => T extends Left ? 1 : 2
) extends (
    <T>() => T extends Right ? 1 : 2
) ? true : false;

// The public author theme retains every field already admitted by the host snapshot owner.
type _PublicThemeSnapshotMatchesProtocol = Assert<IsEqual<PluginUiThemeV1, ProtocolSurfaceContext['theme']>>;
