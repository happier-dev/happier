import type { ConversationProviderSetupResultV1 } from '@happier-dev/channels-protocol/v1';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import { DISCORD_MESSAGE_MAXIMUM_CODE_POINTS } from './discordDelivery.js';

export const DISCORD_MESSAGE_CONTENT_INTENT = 1 << 15;
export const DISCORD_GUILDS_INTENT = 1 << 0;
export const DISCORD_BASE_GATEWAY_INTENTS = DISCORD_GUILDS_INTENT | (1 << 9) | (1 << 12);

export type DiscordRequiredPermission = Readonly<{
  id: 'viewChannels' | 'sendMessages' | 'sendMessagesInThreads' | 'readMessageHistory';
  label: string;
  bit: bigint;
}>;

export type DiscordPermissionOverwriteEvidence = Readonly<{
  id: string;
  kind: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}>;

export type DiscordGuildRolePermissionEvidence = Readonly<{
  roleId: string;
  permissions: bigint;
}>;

export type DiscordEndpointPermissionVerification =
  | Readonly<{ kind: 'verified' }>
  | Readonly<{
      kind: 'missing';
      permissionIds: readonly DiscordRequiredPermission['id'][];
    }>
  | Readonly<{ kind: 'invalidEvidence' }>;

/** One table is both the invite bitfield source and the user-facing list. */
export const DISCORD_REQUIRED_PERMISSIONS = Object.freeze([
  { id: 'viewChannels', label: 'View Channels', bit: 1n << 10n },
  { id: 'sendMessages', label: 'Send Messages', bit: 1n << 11n },
  { id: 'sendMessagesInThreads', label: 'Send Messages in Threads', bit: 1n << 38n },
  { id: 'readMessageHistory', label: 'Read Message History', bit: 1n << 16n },
] satisfies readonly DiscordRequiredPermission[]);

const DISCORD_ADMINISTRATOR_PERMISSION = 1n << 3n;

export type VerifiedDiscordApplication = Readonly<{
  applicationId: string;
  botUserId: string;
  botLabel?: string;
}>;

function requireImmutableId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function requiredPermissionsBitfield(): bigint {
  return DISCORD_REQUIRED_PERMISSIONS.reduce((result, permission) => result | permission.bit, 0n);
}

function requiredPermissionsForEndpoint(kind: 'shared' | 'thread'): readonly DiscordRequiredPermission[] {
  return DISCORD_REQUIRED_PERMISSIONS.filter((permission) => (
    kind === 'thread'
      ? permission.id !== 'sendMessages'
      : permission.id !== 'sendMessagesInThreads'
  ));
}

function applyOverwrite(permissions: bigint, overwrite: Readonly<{ allow: bigint; deny: bigint }>): bigint {
  return (permissions & ~overwrite.deny) | overwrite.allow;
}

/**
 * Computes the current bot's effective target permissions from the exact
 * guild-role/member and channel-overwrite evidence returned by Discord. The
 * setup permission table remains the sole source of required bits for both
 * invitation remediation and endpoint verification.
 */
export function verifyDiscordEndpointPermissions(input: Readonly<{
  endpointKind: 'shared' | 'thread';
  guildId: string;
  botUserId: string;
  botRoleIds: readonly string[];
  guildRoles: readonly DiscordGuildRolePermissionEvidence[];
  permissionOverwrites: readonly DiscordPermissionOverwriteEvidence[];
}>): DiscordEndpointPermissionVerification {
  const guildId = requireImmutableId(input.guildId, 'Discord guild ID');
  const botUserId = requireImmutableId(input.botUserId, 'Discord bot user ID');
  const rolesById = new Map<string, bigint>();
  for (const role of input.guildRoles) {
    const roleId = requireImmutableId(role.roleId, 'Discord role ID');
    if (rolesById.has(roleId) || role.permissions < 0n) return { kind: 'invalidEvidence' };
    rolesById.set(roleId, role.permissions);
  }
  const everyonePermissions = rolesById.get(guildId);
  if (everyonePermissions === undefined) return { kind: 'invalidEvidence' };

  let permissions = everyonePermissions;
  const memberRoleIds = new Set<string>();
  for (const roleId of input.botRoleIds) {
    const normalizedRoleId = requireImmutableId(roleId, 'Discord bot role ID');
    if (normalizedRoleId === guildId || memberRoleIds.has(normalizedRoleId)) continue;
    const rolePermissions = rolesById.get(normalizedRoleId);
    if (rolePermissions === undefined) return { kind: 'invalidEvidence' };
    memberRoleIds.add(normalizedRoleId);
    permissions |= rolePermissions;
  }
  if ((permissions & DISCORD_ADMINISTRATOR_PERMISSION) !== 0n) return { kind: 'verified' };

  const overwrites = new Set<string>();
  let everyoneOverwrite: DiscordPermissionOverwriteEvidence | null = null;
  let roleAllow = 0n;
  let roleDeny = 0n;
  let memberOverwrite: DiscordPermissionOverwriteEvidence | null = null;
  for (const overwrite of input.permissionOverwrites) {
    const id = requireImmutableId(overwrite.id, 'Discord permission overwrite ID');
    if (overwrite.allow < 0n || overwrite.deny < 0n) return { kind: 'invalidEvidence' };
    const overwriteKey = `${overwrite.kind}:${id}`;
    if (overwrites.has(overwriteKey)) return { kind: 'invalidEvidence' };
    overwrites.add(overwriteKey);
    if (overwrite.kind === 'role' && id === guildId) {
      everyoneOverwrite = overwrite;
      continue;
    }
    if (overwrite.kind === 'role' && memberRoleIds.has(id)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
      continue;
    }
    if (overwrite.kind === 'member' && id === botUserId) memberOverwrite = overwrite;
  }
  if (everyoneOverwrite !== null) permissions = applyOverwrite(permissions, everyoneOverwrite);
  permissions = applyOverwrite(permissions, { allow: roleAllow, deny: roleDeny });
  if (memberOverwrite !== null) permissions = applyOverwrite(permissions, memberOverwrite);

  const missing = requiredPermissionsForEndpoint(input.endpointKind)
    .filter((permission) => (permissions & permission.bit) !== permission.bit)
    .map((permission) => permission.id);
  return missing.length === 0
    ? { kind: 'verified' }
    : { kind: 'missing', permissionIds: missing };
}

export function calculateDiscordGatewayIntents(messageContentIntentEnabled: boolean): number {
  return messageContentIntentEnabled
    ? DISCORD_BASE_GATEWAY_INTENTS | DISCORD_MESSAGE_CONTENT_INTENT
    : DISCORD_BASE_GATEWAY_INTENTS;
}

export function buildDiscordInviteUrl(applicationId: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', requireImmutableId(applicationId, 'Discord application ID'));
  url.searchParams.set('scope', 'bot');
  url.searchParams.set('permissions', requiredPermissionsBitfield().toString());
  return url.toString();
}

export function createDiscordSetupResult(
  application: VerifiedDiscordApplication,
  credentialRef: ConnectedAccountRef,
): ConversationProviderSetupResultV1 {
  const applicationId = requireImmutableId(application.applicationId, 'Discord application ID');
  const botUserId = requireImmutableId(application.botUserId, 'Discord bot user ID');
  const label = application.botLabel?.trim();
  return {
    v: 1,
    credentialRef,
    providerConnectionKey: `discord:application:${applicationId}`,
    providerConfigVersion: 1,
    providerConfig: { applicationId, botUserId, inviteUrl: buildDiscordInviteUrl(applicationId) },
    integrationPrincipal: {
      id: `discord:bot:${botUserId}`,
      ...(label ? { label } : {}),
    },
    supportedTransports: ['socket'],
    recommendedTransport: 'socket',
    overlapSafety: 'safe',
    replayContinuity: 'sessionBound',
    outboundTextLimit: { maximum: DISCORD_MESSAGE_MAXIMUM_CODE_POINTS, unit: 'unicodeCodePoints' },
  };
}
