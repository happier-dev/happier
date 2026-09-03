import { code, glyph, sectionHeader, severity } from '@/ui/format/styles';
import type { AuthProfileSnapshot } from '@/diagnostics/doctorRepair';

import { authSignInCommand } from '../authSignInCommand';

const SECTION_HEADER = 'Authentication';

/**
 * `Authentication` section.
 *
 * Principle: the active profile is what 99% of `doctor repair` runs care about;
 * everything else is noise until a finding touches it. So we render the active
 * profile in detail, collapse signed-in inactive profiles into a summary
 * counter, and promote "needs action" inactive profiles (expired, not signed
 * in, machine not registered) back to visible cards — because those CAN block
 * a user who switches profiles soon.
 *
 * Line anatomy per profile:
 *   [glyph] [name] [active/inactive marker]  —  on <url>  —  <status>
 *     → <one-line remedy, only when action is needed>
 */
export function renderAuthentication(
  profiles: readonly AuthProfileSnapshot[],
  hasAny: boolean,
  invoker: string = 'happier',
): string[] {
  if (!hasAny) {
    return [
      sectionHeader(SECTION_HEADER),
      `  ${glyph.info()} ${severity.info('No server profiles configured.')}`,
      `    ${glyph.arrow()} sign in: ${code(authSignInCommand(invoker))}`,
    ];
  }
  if (profiles.length === 0) return [];

  const active = profiles.find((p) => p.isActive) ?? null;
  const others = profiles.filter((p) => !p.isActive);
  const othersNeedingAction = others.filter((p) => {
    const status = statusFor(p);
    return status !== 'signed-in' && status !== 'recorded';
  });
  const othersRecorded = others.length - othersNeedingAction.length;

  // Collect rows as blocks (multi-line when a remedy/sub-line is included,
  // single-line otherwise). Only separate with a blank line when at least
  // one of the two neighbouring blocks is multi-line — stacking single
  // lines keeps the list feeling cohesive.
  const blocks: string[][] = [];
  if (active) blocks.push(renderProfileBlock(active, invoker));
  for (const p of othersNeedingAction) blocks.push(renderProfileBlock(p, invoker));
  if (othersRecorded > 0) {
    const word = othersRecorded === 1 ? 'profile has' : 'profiles have';
    blocks.push([`  ${glyph.info()} ${severity.info(`${othersRecorded} other ${word} a sign-in record (not verified) · run ${code(`${invoker} server list`)} to see all`)}`]);
  }
  const lines: string[] = [sectionHeader(SECTION_HEADER)];
  for (let i = 0; i < blocks.length; i += 1) {
    const prev = blocks[i - 1];
    const curr = blocks[i];
    if (i > 0 && ((prev?.length ?? 0) > 1 || curr.length > 1)) {
      lines.push('');
    }
    lines.push(...curr);
  }
  return lines;
}

function renderProfileBlock(p: AuthProfileSnapshot, invoker: string): string[] {
  const status = statusFor(p);
  const g = glyphForStatus(status);
  const marker = p.isActive ? ' (active)' : '';
  const nameDisplay = p.isActive ? severity.action(p.serverName + marker) : p.serverName;
  const statusWord = statusWordFor(status);
  const statusRendered = status === 'signed-in' && p.reachability !== 'unreachable'
    ? severity.success(statusWord)
    : severity.info(statusWord);
  const primary = `  ${g} ${nameDisplay}  ${severity.info('—')}  ${severity.info(`on ${p.serverUrl}`)}  ${severity.info('—')}  ${statusRendered}`;

  const remedy = remedyFor(p, status, invoker);
  if (!remedy) return [primary];
  return [primary, `    ${glyph.arrow()} ${remedy}`];
}

type ProfileStatus = 'signed-in' | 'expired' | 'not-registered' | 'not-signed-in' | 'unverified' | 'recorded' | 'not-recorded';

function statusFor(p: AuthProfileSnapshot): ProfileStatus {
  if (p.credentialEvidence === 'historical-record') {
    return p.hasCredentials ? 'recorded' : 'not-recorded';
  }
  if (p.reachability === 'unreachable') return 'unverified';
  if (!p.hasCredentials) return 'not-signed-in';
  if (p.isExpired) return 'expired';
  if (!p.machineRegistered) return 'not-registered';
  return 'signed-in';
}

function glyphForStatus(status: ProfileStatus): string {
  if (status === 'signed-in') return glyph.success();
  if (status === 'expired') return glyph.action();
  if (status === 'not-registered') return glyph.action();
  return glyph.info();
}

function statusWordFor(status: ProfileStatus): string {
  switch (status) {
    case 'signed-in': return 'signed in';
    case 'expired': return 'session expired';
    case 'not-registered': return 'machine not registered';
    case 'not-signed-in': return 'not signed in';
    case 'unverified': return 'stored credential could not be verified';
    case 'recorded': return 'sign-in recorded · not verified';
    case 'not-recorded': return 'no recorded sign-in';
  }
}

function remedyFor(p: AuthProfileSnapshot, status: ProfileStatus, invoker: string): string | null {
  switch (status) {
    case 'signed-in': return null;
    case 'recorded': return null;
    case 'unverified': return severity.info('server didn’t respond — stored credential was kept unchanged');
    case 'expired': return `re-sign in: ${code(authSignInCommand(invoker, p.serverId))}`;
    case 'not-registered': return `register: ${code(`${invoker} daemon start`)}`;
    case 'not-signed-in': return `sign in: ${code(authSignInCommand(invoker, p.serverId))}`;
    case 'not-recorded': return `sign in: ${code(authSignInCommand(invoker, p.serverId))}`;
  }
}
