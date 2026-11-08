import { expect, it } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from './externalActionApi.js';
import { decodeExternalActionHttpBodyV1, encodeExternalActionHttpBodyV1 } from './externalActionExecutionAuthorization.js';

const headers = {
  [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'synthetic-root',
  [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: 'synthetic-signature',
  [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.deploy',
  [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: 'synthetic-target',
  [EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER]: 'synthetic-child',
  [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: 'synthetic-reviewed-child',
};

it.each([undefined, null, { environmentId: 'environment', v: 1, authorization: 'application data' }])(
  'preserves the logical signed body and every proof without exposing unrelated headers', body => {
    const frame = encodeExternalActionHttpBodyV1({ ...headers, authorization: 'unrelated-bearer' }, body);
    expect(decodeExternalActionHttpBodyV1(frame)).toEqual({ headers, body });
    expect(JSON.stringify(frame)).not.toContain('unrelated-bearer');
  });

it('rejects unknown transport fields and incomplete proof frames', () => {
  const frame = { v: 1, authorization: { executionAuthorization: 'root', machineSignature: 'signature',
    effectActionId: 'deployments.deploy', target: 'target' }, body: {} };
  expect(decodeExternalActionHttpBodyV1(frame)).not.toBeNull();
  for (const invalid of [null, { ...frame, v: 2 }, { ...frame, extra: true },
    { ...frame, authorization: { ...frame.authorization, extra: true } },
    { ...frame, authorization: { ...frame.authorization, executionAuthorization: '' } },
    { ...frame, authorization: { target: 'target' } }]) {
    expect(decodeExternalActionHttpBodyV1(invalid)).toBeNull();
  }
  expect(encodeExternalActionHttpBodyV1({}, {})).toBeNull();
});
