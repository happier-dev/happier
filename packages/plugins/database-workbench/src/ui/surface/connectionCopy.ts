import type { PluginTranslate } from '@happier-dev/plugin-ui';

export function translateUnverifiedServerNotice(translate: PluginTranslate): string {
  return translate(
    'plugins.database.connection.unverifiedServer',
    'The connection is encrypted, but the provider can’t prove this is your database server.',
  );
}
