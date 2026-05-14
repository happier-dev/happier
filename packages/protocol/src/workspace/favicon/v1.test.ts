import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '../../rpc.js';
import {
  WorkspaceFaviconResolveRequestV1Schema,
  WorkspaceFaviconResolveResponseV1Schema,
} from './v1.js';

describe('workspace favicon protocol v1', () => {
  it('defines the machine RPC method used to resolve workspace favicons', () => {
    expect(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE).toBe('workspace.favicon.resolve');
  });

  it('accepts found, missing, and error resolver responses', () => {
    expect(WorkspaceFaviconResolveRequestV1Schema.parse({
      workspacePath: '/repo',
    })).toEqual({ workspacePath: '/repo' });

    expect(WorkspaceFaviconResolveResponseV1Schema.parse({
      success: true,
      found: true,
      relativePath: 'public/favicon.svg',
      mimeType: 'image/svg+xml',
      contentBase64: 'PHN2Zy8+',
      sizeBytes: 6,
      modifiedMs: 42,
    })).toMatchObject({
      success: true,
      found: true,
      relativePath: 'public/favicon.svg',
    });

    expect(WorkspaceFaviconResolveResponseV1Schema.parse({
      success: true,
      found: false,
    })).toEqual({ success: true, found: false });

    expect(WorkspaceFaviconResolveResponseV1Schema.parse({
      success: false,
      errorCode: 'INVALID_WORKSPACE_PATH',
      error: 'Workspace path is not allowed',
    })).toMatchObject({
      success: false,
      errorCode: 'INVALID_WORKSPACE_PATH',
    });
  });
});
