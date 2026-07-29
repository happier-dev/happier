import type {
  PluginSessionResourceTargetV1,
  PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginUiPortableAction =
  | Readonly<{
    kind: 'hostAction';
    id: string;
    input?: PluginUiJsonValueV1;
  }>
  | Readonly<{
    kind: 'copy';
    value: string;
  }>
  | Readonly<{
    kind: 'openExternal';
    url: string;
  }>
  | Readonly<{
    kind: 'openSurface';
    surfaceId: string;
  }>
  | Readonly<{
    kind: 'refresh';
    resource?: PluginSessionResourceTargetV1;
  }>;
