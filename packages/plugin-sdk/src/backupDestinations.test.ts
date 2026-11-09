import { describe, expect, it } from 'vitest';
import * as destinations from './backupDestinations.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';

describe('backup destination open result', () => {
  it('accepts nonsecret locator/options and refuses secret or executable output', () => {
    const schema = Reflect.get(destinations, 'BackupDestinationOpenV1ProtocolSchema') as ProtocolComposableSchema<unknown> | undefined;
    expect(schema).toBeDefined();
    if (!schema) throw new Error('Public backup destination result schema is missing');
    const opened = {
      repository: 's3:https://objects.example.test/recovery',
      credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
      s3: { region: 'eu-central-1', addressing: 'path' },
    };
    expect(schema.parse(opened)).toEqual(opened);
    for (const value of [
      { ...opened, argv: ['--password-file', '/secret'] },
      { ...opened, s3: { ...opened.s3, secretAccessKey: 'secret' } },
      { ...opened, credentialBindings: [{ ...opened.credentialBindings[0], value: 'secret' }] },
      { ...opened, credentialBindings: [{ ...opened.credentialBindings[0], role: 'unrecognized' }] },
      { ...opened, credentialBindings: [{ ...opened.credentialBindings[0], configKey: 'other' }] },
    ]) expect(schema.safeParse(value).success).toBe(false);
  });
});
