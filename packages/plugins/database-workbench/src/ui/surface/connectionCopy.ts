import type { PluginTranslate } from '@happier-dev/plugin-ui';

export function translateUnverifiedServerNotice(translate: PluginTranslate): string {
  return translate(
    'plugins.database.connection.unverifiedServer',
    'The connection is encrypted, but the server’s identity isn’t verified.',
  );
}
