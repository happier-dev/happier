import inspector from 'node:inspector';
import { z } from 'zod';
import { expect, it } from 'vitest';

it('admits the hosted Account Data declarations without constructing unused operation validators', async () => {
  // Observe real construction in this test process; no schema factory or parser
  // is replaced, and no product diagnostic/reset surface is needed.
  const session = new inspector.Session();
  session.connect();
  const urls = new Map<string, string>();
  const constructions: string[] = [];
  session.on('Debugger.scriptParsed', ({ params }) => urls.set(params.scriptId, params.url));
  session.on('Debugger.paused', ({ params }) => {
    const owner = params.callFrames.find(frame => /\/plugins\/data\/hostedWebAccountDataBridgeV1\.ts$/u.test(urls.get(frame.location.scriptId) ?? frame.url));
    if (owner) constructions.push(owner.functionName);
    session.post('Debugger.resume');
  });
  const globalKey = '__hostedDataConstructionTest';
  Reflect.set(globalThis, globalKey, z.object);
  try {
    await new Promise<void>((resolve, reject) => session.post('Debugger.enable', error => error ? reject(error) : resolve()));
    const evaluated = await new Promise<inspector.Runtime.EvaluateReturnType>((resolve, reject) =>
      session.post('Runtime.evaluate', { expression: `globalThis.${globalKey}` }, (error, result) => error ? reject(error) : resolve(result)));
    expect(evaluated.result.objectId).toBeDefined();
    await new Promise<void>((resolve, reject) => session.post('Debugger.setBreakpointOnFunctionCall',
      { objectId: evaluated.result.objectId! }, error => error ? reject(error) : resolve()));
    const bridge = await import('./hostedWebAccountDataBridgeV1.js');
    expect(constructions, 'definition admission must leave operational object schemas cold').toEqual([]);
    expect(bridge.PluginHostedWebAccountDataBridgeRequestV1Schema.parse({ kind: 'cancel', requestSequence: 7 }))
      .toEqual({ kind: 'cancel', requestSequence: 7 });
    expect(bridge.PluginHostedWebAccountDataBridgeRequestV1Schema.safeParse({ kind: 'cancel', requestSequence: -1 }).success).toBe(false);
    expect(constructions.length).toBeGreaterThan(0);
  } finally {
    Reflect.deleteProperty(globalThis, globalKey);
    session.disconnect();
  }
});
