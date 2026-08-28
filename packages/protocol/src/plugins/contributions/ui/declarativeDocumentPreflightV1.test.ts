import { describe, expect, it } from 'vitest';

import { cloneStrictPluginJsonValue } from '../strictJsonValue.js';
import {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_PLAIN_VALUES_V1,
  preflightPluginDeclarativeDocumentV1,
} from './declarativeDocumentPreflightV1.js';

function actionDocumentWithInput(input: unknown): unknown {
  return {
    version: 1,
    root: {
      kind: 'action',
      action: { pluginId: 'com.acme.dashboard', localId: 'refresh' },
      input,
    },
  };
}

function nestedInputAtWholeDocumentDepth(depth: number): unknown {
  // Document → root → input places a scalar at depth three. Each wrapper adds
  // one complete plain-data level; the document envelope itself is depth one.
  let value: unknown = null;
  for (let currentDepth = 3; currentDepth < depth; currentDepth += 1) {
    value = { value };
  }
  return value;
}

describe('declarative document structural preflight', () => {
  it('accepts depth 48 and rejects depth 49 through the declarative-only profile', () => {
    const accepted = actionDocumentWithInput(nestedInputAtWholeDocumentDepth(
      MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
    ));
    const rejected = actionDocumentWithInput(nestedInputAtWholeDocumentDepth(
      MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1 + 1,
    ));

    expect(preflightPluginDeclarativeDocumentV1(accepted).ok).toBe(true);
    expect(preflightPluginDeclarativeDocumentV1(rejected)).toMatchObject({
      ok: false,
      code: 'plugin_declarative_document_depth_exceeded',
    });
    expect(() => cloneStrictPluginJsonValue(rejected, 'value')).not.toThrow();
  });

  it('accepts 8,192 total values and rejects the next value without a generic JSON quota', () => {
    // The envelope/action before array entries contains eight values including
    // the input array itself, so 8,184 nulls reach the exact total boundary.
    const acceptedEntries = MAX_PLUGIN_DECLARATIVE_DOCUMENT_PLAIN_VALUES_V1 - 8;
    const accepted = actionDocumentWithInput(Array.from({ length: acceptedEntries }, () => null));
    const rejected = actionDocumentWithInput(Array.from({ length: acceptedEntries + 1 }, () => null));

    expect(preflightPluginDeclarativeDocumentV1(accepted).ok).toBe(true);
    expect(preflightPluginDeclarativeDocumentV1(rejected)).toMatchObject({
      ok: false,
      code: 'plugin_declarative_document_values_exceeded',
    });
    expect(() => cloneStrictPluginJsonValue(rejected, 'value')).not.toThrow();
  });
});
