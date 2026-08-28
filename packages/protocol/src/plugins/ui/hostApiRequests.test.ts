import { describe, expect, it } from 'vitest';

import {
  PluginUiAcquireComposerInputLockRequestV1Schema,
  PluginUiActiveComposerResultV1Schema,
  PluginUiApplyComposerRequestV1Schema,
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  PluginUiFocusComposerRequestV1Schema,
  PluginUiInspectComposerContentRequestV1Schema,
  PluginUiReadComposerRequestV1Schema,
  PluginUiPickComposerMediaRequestV1Schema,
  PluginUiReleaseComposerContentRequestV1Schema,
  PluginUiSetComposerDecorationsRequestV1Schema,
  PluginUiWatchComposerRequestV1Schema,
  PluginUiDeclarativeOpenSurfaceSelectorV1Schema,
  PluginUiExecuteActionRequestV1Schema,
  PluginUiHostApiResponseEnvelopeV1Schema,
  PluginUiHostApiRequestEnvelopeV1Schema,
  PluginUiHostApiDiagnosticV1Schema,
  PluginUiLaunchInputV1Schema,
  PluginUiOpenSurfaceRequestV1Schema,
  PluginUiOpenNewSessionRequestV1Schema,
  PluginUiPreparedReviewWorkspaceResultV1Schema,
  PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1,
  PluginUiReplacePageLocationRequestV1Schema,
  PluginUiReplacePageLocationResultV1Schema,
  PluginUiSelectActionInputRequestV1Schema,
  PluginUiSelectActionInputResultV1Schema,
  normalizePluginUiMountedContributedActionReferenceV1,
} from './hostApiRequests.js';

const surface = {
  pluginId: 'acme.preview',
  contributionId: 'preview-web',
  surfaceId: 'sessionSurface:acme.preview:preview-pane',
  sessionId: 'session-1',
  placement: 'sessionPane',
  platform: 'web',
  channel: 'internal',
} as const;

const admittedPoint = {
  pointId: 'connection',
  protocol: { id: 'connection', version: 1 },
} as const;

const admittedOperation = {
  point: admittedPoint,
  contributor: {
    pluginId: 'happier.scm.forge.github',
    contributionId: 'github-connection',
    immutableGenerationId: 'contributor-generation-1',
  },
  role: 'setup',
  action: { pluginId: 'happier.scm.forge.github', localId: 'connection/prepare-v1' },
} as const;

function nestedJson(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}

describe('plugin UI diagnostic bounds', () => {
  it('rejects deep oversized details without entering recursive JSON.stringify', () => {
    expect(() => PluginUiHostApiDiagnosticV1Schema.safeParse({
      code: 'deep-diagnostic',
      severity: 'error',
      details: nestedJson(12_000),
    })).not.toThrow();
    expect(PluginUiHostApiDiagnosticV1Schema.safeParse({
      code: 'deep-diagnostic',
      severity: 'error',
      details: nestedJson(12_000),
    }).success).toBe(false);
  });
});

describe('plugin UI Host API response envelope', () => {
  it('keeps a domain result separate from a typed host error even when its JSON carries an error code', () => {
    const response = PluginUiHostApiResponseEnvelopeV1Schema.parse({
      version: 1,
      requestId: 'request-1',
      surface,
      method: 'executeAction',
      kind: 'result',
      payload: {
        code: 'timeout',
        outcome: 'domain-success',
      },
    });

    expect(response).toMatchObject({
      kind: 'result',
      payload: { code: 'timeout', outcome: 'domain-success' },
    });
    expect(PluginUiHostApiResponseEnvelopeV1Schema.safeParse({
      version: 1,
      requestId: 'request-1',
      surface,
      method: 'executeAction',
      payload: { code: 'timeout' },
    }).success).toBe(false);
  });
});

const admittedSelection = {
  target: {
    pluginId: 'acme.preview',
    immutableGenerationId: 'target-generation-1',
  },
  point: admittedPoint,
  contributor: admittedOperation.contributor,
} as const;

describe('plugin UI Composer host API payloads', () => {
    const composer = { kind: 'session', sessionId: 'session-1' } as const;
    const mediaHandle = {
      v: 1,
      id: 'staged-image-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'acme.preview', localId: 'image' },
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'hero.png',
      sizeBytes: 2,
      sha256: 'a'.repeat(64),
    } as const;

  it('embeds the exact Composer ref validator in Zod-owned host API parents', () => {
    expect(PluginUiActiveComposerResultV1Schema.safeParse({ kind: 'session' }).success).toBe(false);
    expect(PluginUiReadComposerRequestV1Schema.safeParse({
      ref: { kind: 'session' },
    }).success).toBe(false);
    expect(PluginUiPickComposerMediaRequestV1Schema.safeParse({
      ref: { kind: 'session' },
      request: { attachmentLocalId: 'image', kinds: ['image'] },
    }).success).toBe(false);
  });

  it('keeps every flat Composer request strict and preserves ordinary absence as a result', () => {
    expect(PluginUiActiveComposerResultV1Schema.parse(null)).toBeNull();
    expect(PluginUiActiveComposerResultV1Schema.parse(composer)).toEqual(composer);

    expect(PluginUiReadComposerRequestV1Schema.parse({ ref: composer })).toEqual({ ref: composer });
    expect(PluginUiWatchComposerRequestV1Schema.parse({ ref: composer })).toEqual({ ref: composer });
    expect(PluginUiApplyComposerRequestV1Schema.parse({
      ref: composer,
      transaction: { expectedRevision: 4, operations: [{ kind: 'text.clear' }] },
    })).toEqual({
      ref: composer,
      transaction: { expectedRevision: 4, operations: [{ kind: 'text.clear' }] },
    });
    expect(PluginUiFocusComposerRequestV1Schema.parse({ ref: composer })).toEqual({ ref: composer });
    expect(PluginUiSetComposerDecorationsRequestV1Schema.parse({
      ref: composer,
      key: 'acme.issue.diagnostics',
      decorations: null,
    })).toEqual({
      ref: composer,
      key: 'acme.issue.diagnostics',
      decorations: null,
    });
    expect(PluginUiAcquireComposerInputLockRequestV1Schema.parse({
      ref: composer,
      request: { reason: 'Preparing issue context', mode: 'submit' },
    })).toEqual({
      ref: composer,
      request: { reason: 'Preparing issue context', mode: 'submit' },
    });

    expect(PluginUiReadComposerRequestV1Schema.safeParse({ ref: composer, extra: true }).success).toBe(false);
    expect(PluginUiSetComposerDecorationsRequestV1Schema.safeParse({
      ref: composer,
      key: 'acme.issue.diagnostics',
      decorations: null,
      revision: 4,
    }).success).toBe(false);
    expect(PluginUiAcquireComposerInputLockRequestV1Schema.safeParse({
      ref: composer,
      request: { reason: 'Preparing issue context', mode: 'submit' },
      subscriptionId: 'guest-supplied',
    }).success).toBe(false);
  });

  it('admits only opaque host-bound media operations and never a transfer payload', () => {
    expect(PluginUiPickComposerMediaRequestV1Schema.parse({
      ref: composer,
      request: { attachmentLocalId: 'image', kinds: ['image'] },
    })).toEqual({
      ref: composer,
      request: { attachmentLocalId: 'image', kinds: ['image'] },
    });
    expect(PluginUiInspectComposerContentRequestV1Schema.parse({
      handle: mediaHandle,
      request: { offset: 0, maxBytes: 2 },
    })).toEqual({
      handle: mediaHandle,
      request: { offset: 0, maxBytes: 2 },
    });
    expect(PluginUiReleaseComposerContentRequestV1Schema.parse({ handle: mediaHandle }))
      .toEqual({ handle: mediaHandle });

    expect(PluginUiPickComposerMediaRequestV1Schema.safeParse({
      ref: composer,
      request: { attachmentLocalId: 'image', kinds: ['image', 'image'] },
    }).success).toBe(false);
    expect(PluginUiPickComposerMediaRequestV1Schema.safeParse({
      ref: composer,
      request: { attachmentLocalId: 'image', kinds: ['image'] },
      path: '/tmp/hero.png',
    }).success).toBe(false);
    expect(PluginUiInspectComposerContentRequestV1Schema.safeParse({
      handle: { ...mediaHandle, uri: 'file:///tmp/hero.png' },
      request: { offset: 0, maxBytes: 2 },
    }).success).toBe(false);
    expect(PluginUiInspectComposerContentRequestV1Schema.safeParse({
      handle: mediaHandle,
      request: { offset: 0, maxBytes: 2, bytesBase64: 'aGk=' },
    }).success).toBe(false);
    expect(PluginUiReleaseComposerContentRequestV1Schema.safeParse({
      handle: { ...mediaHandle, sessionId: 'transfer-session-1' },
    }).success).toBe(false);
  });
});

describe('plugin UI launch input bounds', () => {
  function utf8Bytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  it('rejects a value above the canonical UTF-8 bound instead of truncating it', () => {
    const withinBound = { blob: 'a'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 - 64) };
    expect(utf8Bytes(withinBound)).toBeLessThanOrEqual(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1);
    expect(PluginUiLaunchInputV1Schema.parse(withinBound)).toEqual(withinBound);

    const overBound = { blob: 'a'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1) };
    const rejected = PluginUiLaunchInputV1Schema.safeParse(overBound);
    expect(rejected.success).toBe(false);
    // A truncating implementation would report success with a shorter value.
    expect((rejected as { data?: unknown }).data).toBeUndefined();
  });

  it('measures the bound in UTF-8 bytes, not code units', () => {
    // Each `€` is one code unit but three UTF-8 bytes, so a code-unit bound
    // would admit this value.
    const multiByte = '€'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 / 2);
    expect(multiByte.length).toBeLessThan(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1);
    expect(PluginUiLaunchInputV1Schema.safeParse(multiByte).success).toBe(false);
  });

  it('accepts every JSON shape a bounded author argument can take', () => {
    for (const value of [null, true, 7, 'selection', ['a', 'b'], { nested: { id: 'x' } }]) {
      expect(PluginUiLaunchInputV1Schema.safeParse(value).success).toBe(true);
    }
    expect(PluginUiLaunchInputV1Schema.safeParse(() => undefined).success).toBe(false);
  });
});

describe('plugin UI open and Action components', () => {
    it('accepts only one exact mounted admitted operation and keeps its result closed', () => {
    expect(PluginUiSelectActionInputRequestV1Schema.parse({
      operation: admittedOperation,
      draft: { repository: 'happier-dev/happier' },
    })).toEqual({
      operation: admittedOperation,
      draft: { repository: 'happier-dev/happier' },
    });
    expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
      operation: {
        ...admittedOperation,
        callerProvenance: 'forbidden',
      },
    }).success).toBe(false);
    expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
      operation: {
        ...admittedOperation,
        contributorMaterializationId: 'runtime-materialization',
      },
    }).success).toBe(false);
    expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
      operation: {
        ...admittedOperation,
        contributor: undefined,
      },
    }).success).toBe(false);
    expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
      operation: {
        ...admittedOperation,
        point: undefined,
      },
    }).success).toBe(false);
    expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
      operation: {
        ...admittedOperation,
        point: { ...admittedPoint, targetPluginId: 'forbidden-selector' },
      },
    }).success).toBe(false);

    const selectedAccount = {
      service: { pluginId: 'happier.scm.forge.github', localId: 'github' },
      accountId: 'account-1',
    };
    expect(PluginUiSelectActionInputResultV1Schema.parse({
      kind: 'submitted',
      action: {
        pluginId: 'happier.scm.forge.github',
        localId: 'connection/prepare-v1',
      },
      input: { repository: 'happier-dev/happier' },
      selection: admittedSelection,
      connectedAccount: {
        kind: 'selected',
        fieldPath: 'credentialRef',
        ref: selectedAccount,
      },
    })).toMatchObject({
      kind: 'submitted',
      selection: admittedSelection,
      connectedAccount: { kind: 'selected' },
    });
    expect(PluginUiSelectActionInputResultV1Schema.safeParse({
      kind: 'submitted',
      action: admittedOperation.action,
      input: {},
      connectedAccount: { kind: 'none' },
      selection: {
        ...admittedSelection,
        action: admittedOperation.action,
      },
    }).success).toBe(false);
    expect(PluginUiSelectActionInputResultV1Schema.safeParse({
      kind: 'submitted',
      action: admittedOperation.action,
      input: {},
      connectedAccount: { kind: 'none' },
      selection: {
        ...admittedSelection,
        contributor: {
          ...admittedSelection.contributor,
          contributionLocalId: admittedSelection.contributor.contributionId,
        },
      },
    }).success).toBe(false);
    expect(PluginUiSelectActionInputResultV1Schema.parse({ kind: 'cancelled' }))
      .toEqual({ kind: 'cancelled' });
    expect(PluginUiSelectActionInputResultV1Schema.safeParse({
      kind: 'cancelled',
      action: { pluginId: 'acme', localId: 'unexpected' },
    }).success).toBe(false);
    });

    it('admits only the literal no-invoke Session server-start draft request', () => {
        const exactDraft = {
            blob: 'a'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 - 11),
        };
        expect(new TextEncoder().encode(JSON.stringify(exactDraft)).byteLength)
            .toBe(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1);

        expect(PluginUiSelectActionInputRequestV1Schema.parse({
            hostAction: {
                action: 'session.spawn_new',
                projection: 'serverStartDraft',
            },
            draft: exactDraft,
        })).toEqual({
            hostAction: {
                action: 'session.spawn_new',
                projection: 'serverStartDraft',
            },
            draft: exactDraft,
        });

        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            operation: admittedOperation,
            hostAction: {
                action: 'session.spawn_new',
                projection: 'serverStartDraft',
            },
        }).success).toBe(false);
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({ draft: {} }).success).toBe(false);
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            hostAction: {
                action: 'session.spawn_new',
                projection: 'serverStartDraft',
                arbitrary: true,
            },
        }).success).toBe(false);
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            hostAction: {
                action: 'session.spawn_new',
                projection: 'otherProjection',
            },
        }).success).toBe(false);
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            hostAction: {
                action: 'other.action',
                projection: 'serverStartDraft',
            },
        }).success).toBe(false);
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            hostAction: {
                action: 'session.spawn_new',
                projection: 'serverStartDraft',
            },
            draft: { blob: `${exactDraft.blob}a` },
        }).success).toBe(false);

        const serverStartDraft = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
        } as const;
        expect(PluginUiSelectActionInputResultV1Schema.parse({
            kind: 'serverStartDraft',
            draft: serverStartDraft,
        })).toEqual({
            kind: 'serverStartDraft',
            draft: serverStartDraft,
        });
        expect(PluginUiSelectActionInputResultV1Schema.safeParse({
            kind: 'serverStartDraft',
            draft: { ...serverStartDraft, creationKey: 'forbidden' },
        }).success).toBe(false);
        expect(PluginUiSelectActionInputResultV1Schema.safeParse({
            kind: 'serverStartDraft',
            draft: serverStartDraft,
            action: admittedOperation.action,
        }).success).toBe(false);
    });

    it('keeps New Session navigation separate from no-invoke input selection', () => {
        const seed = {
            prompt: 'Repair the failing check',
            profileId: 'profile-review',
            checkoutIntent: 'createWorktree',
            placement: { serverId: 'server-1', machineId: 'machine-1', directory: '/workspace' },
        } as const;

        expect(PluginUiOpenNewSessionRequestV1Schema.parse(seed)).toEqual(seed);
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            seed,
        }).success).toBe(false);

        // A seed that declares only some members stays valid: an absent member
        // is "not seeded", never "seeded empty".
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            placement: { directory: '/workspace' },
        }).success).toBe(true);

        // An ambiguous repository join stays a reader choice. The seed carries
        // the incumbent server-start candidate grammar verbatim, rather than
        // collapsing it into an arbitrary directory or inventing a second
        // candidate shape for the New Session route.
        const candidateSeed = {
            candidates: [{
                projectKey: { id: 'project-api' },
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/worktrees/api',
                label: 'API',
                reachable: true,
                worktrees: [{
                    path: '/worktrees/api',
                    branch: 'main',
                    isMain: true,
                    isCurrent: true,
                }],
            }],
        } as const;
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse(candidateSeed).success).toBe(true);
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            candidates: [],
        }).success).toBe(false);

        // Attachments are the author-shaped half of the incumbent
        // `attachment.add` request. The mounted New Session composer, rather
        // than this Protocol boundary, resolves their host identity and mints
        // an instance after navigation.
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            attachments: [{
                attachmentLocalId: 'entry',
                value: {
                    key: 'triage:42',
                    value: { v: 1, entryId: '42' },
                    presentation: { label: 'Issue #42' },
                },
            }],
        }).success).toBe(true);

        // The one incumbent host arm accepts exactly one authoring mode, and an
        // unknown seed member is refused rather than silently dropped.
        expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
            hostAction: { action: 'session.spawn_new', projection: 'newSessionSeed' },
        }).success).toBe(false);
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            ...seed,
            arbitrary: true,
        }).success).toBe(false);
        // An empty attachment list declares no attach intent and is refused;
        // valid author-shaped additions above remain mounted-composer work.
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            attachments: [],
        }).success).toBe(false);
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            prompt: '   ',
        }).success).toBe(false);
        expect(PluginUiOpenNewSessionRequestV1Schema.safeParse({
            prompt: { text: 'old shape', mode: 'replace' },
        }).success).toBe(false);
        expect(PluginUiSelectActionInputResultV1Schema.safeParse({ kind: 'newSessionSeeded' }).success)
            .toBe(false);
    });

    it('projects only the source-neutral prepared workspace fact', () => {
        expect(PluginUiPreparedReviewWorkspaceResultV1Schema.parse({
            kind: 'prepared',
            repositoryPath: '/worktrees/review-42',
            branch: 'review/pr-42',
            created: true,
        })).toMatchObject({
            kind: 'prepared',
            repositoryPath: '/worktrees/review-42',
        });
        expect(PluginUiPreparedReviewWorkspaceResultV1Schema.safeParse({
            kind: 'prepared',
            repositoryPath: '   ',
        }).success).toBe(false);
        expect(PluginUiPreparedReviewWorkspaceResultV1Schema.safeParse({
            kind: 'unavailable',
        }).success).toBe(false);
    });

    it('applies the canonical host-input byte bound to selection drafts and submissions', () => {
    const oversized = { blob: 'a'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1) };

    expect(PluginUiSelectActionInputRequestV1Schema.safeParse({
      operation: {
        point: admittedPoint,
        contributor: {
          pluginId: 'acme.provider',
          contributionId: 'provider',
          immutableGenerationId: 'contributor-generation-1',
        },
        role: 'setup',
        action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
      },
      draft: oversized,
    }).success).toBe(false);
    expect(PluginUiSelectActionInputResultV1Schema.safeParse({
      kind: 'submitted',
      action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
      input: oversized,
      connectedAccount: { kind: 'none' },
    }).success).toBe(false);
  });

  it('uses one exact qualified destination reference for same-plugin and cross-plugin opens', () => {
    const samePlugin = PluginUiOpenSurfaceRequestV1Schema.parse({
      destination: { pluginId: 'acme.review', localId: 'details' },
      input: { itemId: 'review-1' },
      subPath: '/activity/recent/',
      instanceKey: 'review-1',
    });
    const crossPlugin = PluginUiOpenSurfaceRequestV1Schema.parse({
      destination: { pluginId: 'acme.provider', localId: 'repair' },
    });

    expect(samePlugin.destination).toEqual({ pluginId: 'acme.review', localId: 'details' });
    expect(samePlugin.subPath).toBe('activity/recent');
    expect(crossPlugin.destination).toEqual({ pluginId: 'acme.provider', localId: 'repair' });
    expect(PluginUiOpenSurfaceRequestV1Schema.safeParse({ destination: 'details' }).success).toBe(false);
  });

  it('keeps declarative selectors and mounted concrete requests distinct', () => {
    expect(PluginUiDeclarativeOpenSurfaceSelectorV1Schema.safeParse({
      destination: { pluginId: 'acme.review', localId: 'details' },
      inputPath: '/selection',
      subPathPath: '/location',
      instanceKeyPath: '/selection/id',
    }).success).toBe(true);
    expect(PluginUiDeclarativeOpenSurfaceSelectorV1Schema.safeParse({
      destination: { pluginId: 'acme.review', localId: 'details' },
      input: { itemId: 'review-1' },
    }).success).toBe(false);
    expect(PluginUiOpenSurfaceRequestV1Schema.safeParse({
      destination: { pluginId: 'acme.review', localId: 'details' },
      inputPath: '/selection',
    }).success).toBe(false);
  });

  it('accepts mounted host and local Action references while keeping qualified references exact', () => {
    const hostAction = PluginUiExecuteActionRequestV1Schema.parse({
      action: 'plugins.reload',
      input: { force: true },
    });
    const localAction = PluginUiExecuteActionRequestV1Schema.parse({
      action: 'refresh',
    });
    const qualifiedAction = PluginUiExecuteActionRequestV1Schema.parse({
      action: { pluginId: 'acme.review', localId: 'refresh' },
    });

    expect(hostAction.action).toBe('plugins.reload');
    expect(localAction.action).toBe('refresh');
    expect(qualifiedAction.action).toEqual({ pluginId: 'acme.review', localId: 'refresh' });
    expect(normalizePluginUiMountedContributedActionReferenceV1({
      callerPluginId: 'acme.review',
      action: localAction.action,
    })).toEqual({ pluginId: 'acme.review', localId: 'refresh' });
    expect(normalizePluginUiMountedContributedActionReferenceV1({
      callerPluginId: 'acme.review',
      action: qualifiedAction.action,
    })).toEqual({ pluginId: 'acme.review', localId: 'refresh' });
    // Host ActionSpec recognition comes first; its dotted id is not a
    // contributed local id and therefore cannot be normalized as one.
    expect(normalizePluginUiMountedContributedActionReferenceV1({
      callerPluginId: 'acme.review',
      action: hostAction.action,
    })).toBeNull();
    expect(PluginUiExecuteActionRequestV1Schema.safeParse({
      action: { pluginId: 'acme.review', localId: 'refresh' },
      destination: { pluginId: 'acme.provider', localId: 'repair' },
    }).success).toBe(false);
    expect(PluginUiExecuteActionRequestV1Schema.safeParse({
      action: {
        pluginId: 'acme.review',
        localId: 'refresh',
        unexpected: true,
      },
    }).success).toBe(false);
    expect(PluginUiExecuteActionRequestV1Schema.safeParse({
      action: '   ',
    }).success).toBe(false);
  });
});

describe('plugin UI app-page location replacement', () => {
  it('normalizes both locations, bounds them, and refuses unknown fields', () => {
    // The page root is a real location, and a replacement without a
    // page-internal Back step is the ordinary case.
    expect(PluginUiReplacePageLocationRequestV1Schema.parse({ subPath: '/a//b/' }))
      .toEqual({ subPath: 'a/b' });
    expect(PluginUiReplacePageLocationRequestV1Schema.parse({ subPath: '' }))
      .toEqual({ subPath: '' });
    // The declared Back location rides the SAME bounded sub-path vocabulary,
    // so a page can never nominate a location it could not also navigate to.
    expect(PluginUiReplacePageLocationRequestV1Schema.parse({
      subPath: 'entries/1',
      backLocation: '/entries/',
    })).toEqual({ subPath: 'entries/1', backLocation: 'entries' });

    expect(PluginUiReplacePageLocationRequestV1Schema.safeParse({
      subPath: '../escape',
    }).success).toBe(false);
    expect(PluginUiReplacePageLocationRequestV1Schema.safeParse({
      subPath: 'a',
      backLocation: '../escape',
    }).success).toBe(false);
    expect(PluginUiReplacePageLocationRequestV1Schema.safeParse({
      subPath: 'a',
      push: true,
    }).success).toBe(false);
    expect(PluginUiReplacePageLocationRequestV1Schema.safeParse({}).success).toBe(false);

    const overflow = 'x'.repeat(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 + 1);
    expect(PluginUiReplacePageLocationRequestV1Schema.safeParse({
      subPath: overflow,
    }).success).toBe(false);
    expect(PluginUiReplacePageLocationRequestV1Schema.safeParse({
      subPath: 'a',
      backLocation: overflow,
    }).success).toBe(false);
  });

  it('settles as the host-owned current location and nothing else', () => {
    expect(PluginUiReplacePageLocationResultV1Schema.parse({ subPath: '/a/' }))
      .toEqual({ subPath: 'a' });
    // A result may not smuggle back the plugin's request or a history fact.
    expect(PluginUiReplacePageLocationResultV1Schema.safeParse({
      subPath: 'a',
      backLocation: 'b',
    }).success).toBe(false);
    expect(PluginUiReplacePageLocationResultV1Schema.safeParse({}).success).toBe(false);
  });
});
