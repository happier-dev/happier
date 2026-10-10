/** Home history cleanup captures destination authorities even when history is empty. */
export function emptyAccountSettingsHistoryCaptureResponse(path: string): Readonly<{ status: 200; data: unknown }> | null {
  if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
  if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed', rows: [] } };
  if ([
    '/v1/account/entity-rows/acp', '/v1/account/entity-rows/mcp',
    '/v1/account/entity-rows/connected-accounts/configurations', '/v1/account/entity-rows/connected-accounts/purposes',
    '/v1/account/entity-rows/connected-metadata/presentation', '/v1/account/entity-rows/connected-metadata/acknowledgements',
    '/v1/account/entity-rows/notification-channels', '/v1/account/entity-rows/remote-hosts',
  ].includes(path)) return { status: 200, data: { status: 'absent' } };
  return null;
}
