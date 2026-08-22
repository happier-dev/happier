import * as React from 'react';

import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Button, Card, defineUiSurface, Text } from '@happier-dev/plugin-ui';

import { classifyActionFailure } from './providerDetailActionFailure.js';

function readContextActionResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const screen = result.screen;
  const invocationSurface = result.invocationSurface;
  return typeof screen === 'string' && typeof invocationSurface === 'string'
    ? `${screen}:${invocationSurface}`
    : null;
}

function ProviderDetail(context: RenderContext) {
  const { hostApi } = context;
  const [actionResult, setActionResult] = React.useState('not-invoked');
  const [actionInvocationCount, setActionInvocationCount] = React.useState(0);
  const [webOnlyActionResult, setWebOnlyActionResult] = React.useState('not-invoked');
  const [writesLocalActionResult, setWritesLocalActionResult] = React.useState('not-applied');
  React.useEffect(() => {
    hostApi.publishCurrentUiContext({
      entity: {
        kind: 'provider',
        label: 'Packed targeted provider',
        summary: 'External provider detail contributed through the public SDK.',
      },
      detail: {
        source: 'packed-external-plugin',
      },
      commands: [{
        title: 'Inspect packed provider context',
        command: {
          kind: 'executeAction',
          action: 'inspect-context',
        },
      }],
    });
    return () => hostApi.publishCurrentUiContext(null);
  }, [hostApi]);

  const executeContextAction = React.useCallback(async (action: string, delayMs?: number) => {
    const result = await hostApi.executeAction(
      action,
      delayMs === undefined ? {} : { delayMs },
    );
    return readContextActionResult(result);
  }, [hostApi]);

  const inspectCurrentContext = React.useCallback(async (delayMs?: number) => {
    try {
      const result = await executeContextAction('inspect-context', delayMs);
      if (result) {
        setActionResult(result);
        setActionInvocationCount((count) => count + 1);
        return;
      }
      setActionResult('invalid-result');
    } catch (error) {
      // The host owns generation currentness. A stale Action must not be
      // mistaken for an arbitrary client Action failure in this fixture.
      setActionResult(classifyActionFailure(error) === 'retired' ? 'retired' : 'action-error');
    }
  }, [executeContextAction]);

  const inspectWebOnlyContext = React.useCallback(async () => {
    try {
      const result = await executeContextAction('inspect-web-only');
      setWebOnlyActionResult(result ?? 'invalid-result');
    } catch (error) {
      setWebOnlyActionResult(
        classifyActionFailure(error) === 'platform-unavailable'
          ? 'platform-unavailable'
          : 'action-error',
      );
    }
  }, [executeContextAction]);

  const applyLocalEffect = React.useCallback(async () => {
    try {
      const result = await executeContextAction('apply-local-effect');
      setWritesLocalActionResult(result ? `applied:${result}` : 'invalid-result');
    } catch {
      // A rejected confirmation must leave the fixture-local effect unchanged.
      setWritesLocalActionResult('not-applied');
    }
  }, [executeContextAction]);

  return (
    <Card>
      <Text
        testID="packed-targeted-provider-title"
        value="Packed provider detail"
        variant="title"
      />
      <Text
        value="This mounted external surface publishes semantic context through the public Host API."
        tone="secondary"
      />
      <Button
        testID="packed-targeted-context-action"
        title="Inspect packed provider context"
        onPress={() => inspectCurrentContext()}
      />
      <Button
        testID="packed-targeted-stale-context-action"
        title="Inspect before replacement"
        onPress={() => inspectCurrentContext(60_000)}
      />
      <Text
        testID="packed-targeted-context-result"
        value={actionResult}
        tone="secondary"
      />
      <Text
        testID="packed-targeted-context-invocation-count"
        value={String(actionInvocationCount)}
        tone="secondary"
      />
      <Button
        testID="packed-targeted-web-only-context-action"
        title="Inspect packed provider context on web"
        onPress={inspectWebOnlyContext}
      />
      <Text
        testID="packed-targeted-web-only-context-result"
        value={webOnlyActionResult}
        tone="secondary"
      />
      <Button
        testID="packed-targeted-writes-local-action"
        title="Apply packed local change"
        onPress={applyLocalEffect}
      />
      <Text
        testID="packed-targeted-writes-local-result"
        value={writesLocalActionResult}
        tone="secondary"
      />
    </Card>
  );
}

export const renderSurface = defineUiSurface(ProviderDetail);
