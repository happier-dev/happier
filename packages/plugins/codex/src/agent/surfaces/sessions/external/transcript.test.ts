import type { ExternalSessionCandidateV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  mapCodexExternalSessionAppServerCandidateToMetadata,
  mapCodexExternalSessionAppServerPreviewToMessage,
} from './transcript.js';

describe('Codex external-session transcript helpers', () => {
  it('maps app-server preview metadata into a Codex transcript message', () => {
    expect(
      mapCodexExternalSessionAppServerPreviewToMessage({
        remoteSessionId: 'remote_preview',
        metadata: {
          updatedAtMs: 1_736_000_100_000,
          previewText: '  App server preview  ',
          workingDirectory: '/repo/from-app-server',
        },
      }),
    ).toEqual({
      id: 'codex:app-server:remote_preview:1736000100000',
      localId: 'codex:app-server:remote_preview:1736000100000',
      createdAtMs: 1_736_000_100_000,
      raw: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'message',
            message: 'App server preview',
          },
        },
      },
    });
  });

  it('drops blank app-server previews', () => {
    expect(
      mapCodexExternalSessionAppServerPreviewToMessage({
        remoteSessionId: 'remote_preview',
        metadata: {
          updatedAtMs: 1_736_000_100_000,
          previewText: '   ',
          workingDirectory: null,
        },
      }),
    ).toBeNull();
  });

  it('maps app-server candidates into trimmed Codex preview metadata', () => {
    expect(mapCodexExternalSessionAppServerCandidateToMetadata({
      candidate: {
        remoteSessionId: 'remote_preview',
        createdAtMs: 1_736_000_000_000,
        updatedAtMs: 1_736_000_100_999.5,
        title: '  App server preview  ',
        activity: 'idle',
        archived: false,
        details: {
          cwd: '  /repo/from-app-server  ',
        },
      } satisfies ExternalSessionCandidateV1,
    })).toEqual({
      updatedAtMs: 1_736_000_100_999,
      previewText: 'App server preview',
      workingDirectory: '/repo/from-app-server',
    });
  });

  it('drops app-server candidates without a valid updated timestamp', () => {
    expect(mapCodexExternalSessionAppServerCandidateToMetadata({
      candidate: {
        remoteSessionId: 'remote_preview',
        createdAtMs: 1_736_000_000_000,
        updatedAtMs: -1,
        activity: 'idle',
        archived: false,
      } satisfies ExternalSessionCandidateV1,
    })).toBeNull();
  });
});
