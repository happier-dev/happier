import { describe, expect, expectTypeOf, it } from 'vitest';
import { TriageEntryRefV1Schema as canonical, type TriageEntryRefV1 as CanonicalRef } from '@happier-dev/protocol/tasks/entryRefV1';
import * as canonicalTaskIdentity from '@happier-dev/protocol/tasks/entryRefV1';
import type { TriageEntryRefV1 } from './index.js';

import * as sdkProtocol from './index.js';
import * as sdkPublicProtocol from './index.public.js';
import * as sdkBrowserProtocol from './index.browser.js';
import * as featureProtocol from '@happier-dev/triage-protocol/v1';
import { TriageEntryRefV1Schema as featureSchema, buildTriageEntryRouteSegmentV1, readTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';

describe('the shared Task entry reference publication', () => {
  it('publishes the same consumed internal Task identity helpers through Node, browser and feature surfaces', () => {
    for (const surface of [sdkProtocol, sdkPublicProtocol, sdkBrowserProtocol, featureProtocol]) {
      for (const name of ['INTERNAL_TASK_SOURCE_V1', 'internalTaskLocalRefV1', 'internalTaskOwnerAccountIdV1', 'isInternalTaskReferenceV1'] as const) {
        expect(Reflect.get(surface, name), name).toBe(canonicalTaskIdentity[name]);
      }
    }
  });
  it('publishes one parser through Protocol, the SDK and Triage without a feature import in Protocol', () => {
    expect('TriageEntryRefV1Schema' in sdkProtocol).toBe(true);
    expect(Reflect.get(sdkProtocol, 'TriageEntryRefV1Schema')).toBe(canonical);
    expect(featureSchema).toBe(canonical);
    expectTypeOf<TriageEntryRefV1>().toEqualTypeOf<CanonicalRef>();
    const entry = canonical.parse({
      source: { pluginId: 'acme.tasks', localId: 'work-items' },
      kindId: 'task', collisionScope: 'https://example.test\u001forg-1', entryId: '42/é',
    });
    expect(readTriageEntryRouteSegmentV1(buildTriageEntryRouteSegmentV1(entry))).toEqual(entry);
    expect(featureSchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });
});
