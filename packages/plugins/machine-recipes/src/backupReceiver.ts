import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const input = (path: string) => ({ kind: 'input' as const, path });
const template = (value: string, variables: Record<string, string | ReturnType<typeof input>>) => ({ kind: 'template' as const, value, variables });
const marker = template('happier-backup-receiver-{username}', { username: input('username') });
const keyPath = template('/etc/ssh/happier-backup-keys/{username}', { username: input('username') });
const configPath = template('/etc/ssh/sshd_config.d/00-happier-backup-{username}.conf', { username: input('username') });
const keyContent = (key: string) => template('restrict,command="internal-sftp" {key}\n', { key: input(key) });
const policy = template(`# Happier backup receiver {username}
Match User {username}
    ChrootDirectory "{chrootPath}"
    ForceCommand internal-sftp
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
    AuthorizedKeysFile /etc/ssh/happier-backup-keys/{username}
Match all
`, { username: input('username'), chrootPath: input('chrootPath') });
const probe = { kind: 'sshd' as const, contexts: [
  { user: input('username'), host: input('connection.host'), address: input('connection.address') },
  { user: input('administrator.username'), host: input('administrator.host'), address: input('administrator.address') },
] };
const publicKey = { type: 'string' as const,
  pattern: '^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\\r\\n\\u0000]+)?$(?![\\s\\S])',
};
// Paths are quoted in sshd configuration; native token/escape expansion is not
// allowed to change the reviewed filesystem scope.
const path = { type: 'string' as const, pattern: '^/[^\\r\\n\\u0000"\\\\%]*[^/\\r\\n\\u0000"\\\\%]$(?![\\s\\S])' };
const connection = { type: 'object' as const, properties: {
  host: { type: 'string' as const, minLength: 1, pattern: '^[^\\r\\n\\u0000,]+$(?![\\s\\S])' },
  address: { type: 'string' as const, minLength: 1, pattern: '^[^\\r\\n\\u0000,]+$(?![\\s\\S])' },
}, required: ['host', 'address'], additionalProperties: false };
const account = { id: 'receiver-account', kind: 'user' as const, username: input('username'), home: '/',
  shell: '/usr/sbin/nologin', system: true, locked: true, supplementaryGroups: [], ownershipMarker: marker };
const service = { id: 'ssh-service', kind: 'serviceUnit' as const, unit: input('sshServiceUnit'), enabled: true, running: true };
const keyFile = { kind: 'file' as const, path: keyPath, owner: 'root', group: 'root', mode: 0o644 };
const configFile = { kind: 'file' as const, path: configPath, owner: 'root', group: 'root', mode: 0o644,
  validate: probe, probe, onChange: { serviceStepId: service.id, action: 'reload' as const } };

/** Opt-in data only. Unsupported native SSH probes never imply receiver readiness. */
export const BACKUP_RECEIVER_RECIPE = {
  revision: '1', title: 'Backup receiver',
  description: 'A dedicated key-only SFTP login. Removing access preserves the repository and every backup byte.',
  inputSchema: { type: 'object', properties: {
    username: { type: 'string', pattern: '^(?!(?:root|happier|happier-agent|nobody|daemon|bin|sys|sync|games|man|lp|mail|news|uucp|proxy|www-data|backup|list|irc|gnats|sshd|_sshd|messagebus|polkitd|sudo|docker|adm|wheel|shadow|disk|staff|users|nogroup)$)(?!systemd-)[a-z_][a-z0-9_-]*$(?![\\s\\S])' },
    chrootPath: path, repositoryPath: path, senderPublicKey: publicKey, previousSenderPublicKey: publicKey,
    connection,
    administrator: { ...connection, properties: { ...connection.properties, username: {
      type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$(?![\\s\\S])' },
    }, required: ['username', 'host', 'address'] },
    sshServiceUnit: { type: 'string', enum: ['ssh.service', 'sshd.service'] },
  }, required: ['username', 'chrootPath', 'repositoryPath', 'senderPublicKey', 'connection', 'administrator', 'sshServiceUnit'], additionalProperties: false },
  inputConstraints: [{ kind: 'pathWithin', path: 'repositoryPath', root: 'chrootPath' }],
  steps: [
    account,
    { id: 'receiver-chroot', kind: 'directory', path: input('chrootPath'), owner: 'root', group: 'root', mode: 0o755,
      protectedAncestors: true, preserveExistingOwnership: true, ownershipMarker: marker },
    { id: 'receiver-repository', kind: 'directory', path: input('repositoryPath'), owner: input('username'), group: input('username'), mode: 0o700,
      protectedAncestors: true, preserveExistingOwnership: true },
    { id: 'sender-key-directory', kind: 'directory', path: '/etc/ssh/happier-backup-keys', owner: 'root', group: 'root', mode: 0o755,
      protectedAncestors: true, preserveExistingOwnership: true, ownershipMarker: 'happier-backup-authorized-keys' },
    { ...keyFile, id: 'sender-key', content: keyContent('senderPublicKey'),
      when: [{ input: { op: 'not', predicate: { op: 'truthy', path: 'previousSenderPublicKey' } } }] },
    { ...keyFile, id: 'sender-key-rotation', content: keyContent('senderPublicKey'),
      expectedContentDigest: { kind: 'renderedContent', content: keyContent('previousSenderPublicKey') },
      when: [{ input: { op: 'truthy', path: 'previousSenderPublicKey' } }] },
    { ...configFile, id: 'receiver-ssh-policy', content: policy }, service,
  ],
  removeSteps: [
    { ...account, state: 'absent' },
    { ...keyFile, id: 'sender-key', state: 'absent', expectedContentDigest: { kind: 'renderedContent', content: keyContent('senderPublicKey') } },
    { ...configFile, id: 'receiver-ssh-policy', state: 'absent', expectedContentDigest: { kind: 'renderedContent', content: policy } }, service,
  ],
} satisfies Omit<MachineRecipeV1, 'id'>;
