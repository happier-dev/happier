import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentRuntimeSurfaces,
  AttachSurface,
  CheckpointSurface,
} from './surfaces.js';
import type { AgentRuntime, AgentRuntimeBase } from './runtime.js';

type AttachResult = Awaited<ReturnType<AttachSurface['attach']>>;
type AttachReceipt = NonNullable<Extract<AttachResult, { ok: true }>['receipt']>;
type CheckpointRestore = NonNullable<CheckpointSurface['restore']>;
type CheckpointRestoreResult = Awaited<ReturnType<CheckpointRestore>>;
type CheckpointReceipt = NonNullable<CheckpointRestoreResult['receipt']>;

describe('Agent runtime optional surfaces source contract', () => {
  it('does not publish a second outgoing-message mutation owner', () => {
    const surfacesSource = readFileSync(fileURLToPath(new URL('./surfaces.ts', import.meta.url)), 'utf8');
    const runtimeSource = readFileSync(fileURLToPath(new URL('./runtime.ts', import.meta.url)), 'utf8');

    expect(surfacesSource).not.toContain('AgentRuntimeMessages');
    expect(surfacesSource).not.toContain('augmentOutgoing');
    expect(runtimeSource).not.toMatch(/\bmessages\??:/u);
    expectTypeOf<'messages' extends keyof AgentRuntimeBase ? true : false>()
      .toEqualTypeOf<false>();
    expectTypeOf<'messages' extends keyof AgentRuntime ? true : false>()
      .toEqualTypeOf<false>();
  });

  it('projects the SDK-owned attach declaration with identity-only author updates', () => {
    expectTypeOf<AgentRuntimeSurfaces>().toHaveProperty('attach');
    expectTypeOf<NonNullable<AttachReceipt['sessionStateUpdates']>[number]['fieldId']>()
      .toEqualTypeOf<'identity.runtimeDescriptor' | 'identity.providerSessionId'>();
  });

  it('projects the SDK-owned checkpoint declaration with identity-only author updates', () => {
    expectTypeOf<AgentRuntimeSurfaces>().toHaveProperty('checkpoint');
    expectTypeOf<NonNullable<CheckpointReceipt['sessionStateUpdates']>[number]['fieldId']>()
      .toEqualTypeOf<'identity.runtimeDescriptor' | 'identity.providerSessionId'>();
  });

  it('keeps fork and handoff author-owned at the canonical AgentRuntime surface with operation-time invocation context', () => {
    const surfacesSource = readFileSync(fileURLToPath(new URL('./surfaces.ts', import.meta.url)), 'utf8');

    expect(surfacesSource).toContain('export type AgentRuntimeForkSurface');
    expect(surfacesSource).toContain('export type AgentRuntimeHandoffSurface');
    expect(surfacesSource).toContain('readonly fork?: AgentRuntimeForkSurface;');
    expect(surfacesSource).toContain('readonly handoff?: AgentRuntimeHandoffSurface;');
    expect(surfacesSource).toContain('context: PluginInvocationContext');
  });
});
