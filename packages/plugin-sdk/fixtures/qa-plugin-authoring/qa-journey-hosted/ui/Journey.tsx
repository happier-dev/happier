import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPluginUiRenderContext } from '@happier-dev/plugin-sdk/ui/client';
import { defineUiSurface, Tabs, Text } from '@happier-dev/plugin-ui';

function Journey() {
  const [page, select] = useState('overview');
  const [inner, selectInner] = useState('one');
  const [rejected, countRejection] = useState(0);
  return <Tabs presentation="page" pageKind={{ pluginId: 'qa.journey-hosted', localId: 'journey' }}
    ariaLabel="QA Journey pages" value={page} onValueChange={next => {
      if (next === 'reject') countRejection(value => value + 1);
      else select(next);
    }}>
    <Tabs.Item value="overview" title="Journey overview"><Text value={`Hosted overview body; rejected ${rejected}`} /></Tabs.Item>
    <Tabs.Item value="nested" title="Journey nested"><Tabs ariaLabel="QA inner sections" value={inner} onValueChange={selectInner}>
      <Tabs.Item value="one" title="Inner one"><Text value="Hosted inner one body" /></Tabs.Item>
      <Tabs.Item value="two" title="Inner two"><Text value="Hosted inner two body" /></Tabs.Item>
    </Tabs></Tabs.Item>
    <Tabs.Item value="reject" title="Journey reject"><Text value="Rejected body must never render" /></Tabs.Item>
  </Tabs>;
}

const context = await createPluginUiRenderContext();
const root = createRoot(document.getElementById('root')!);
const surface = defineUiSurface(Journey)(context);
if (!React.isValidElement(surface)) throw new Error('QA surface must return a React element');
root.render(surface);
context.signal.addEventListener('abort', () => root.unmount(), { once: true });
