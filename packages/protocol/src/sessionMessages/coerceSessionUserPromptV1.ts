export function coerceSessionUserPromptV1(value: unknown): { text: string } | null {
  if (!value || typeof value !== 'object') return null;

  const v = value as Record<string, unknown>;
  if (v.role !== 'user') return null;

  const content = v.content;

  // Legacy shape: `{ role:'user', content: '...' }`
  if (typeof content === 'string') {
    return { text: content };
  }

  // Canonical shape: `{ role:'user', content: { type:'text', text:'...' } }`
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const contentObj = content as Record<string, unknown>;
    if (contentObj.type === 'text') {
      const text = contentObj.text;
      if (typeof text === 'string') return { text };
    }
  }

  // Provider block/parts shape: `{ role:'user', content: [{type:'text',text:'a'}, ...] }`
  if (Array.isArray(content)) {
    let out = '';
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type === 'text' && typeof itemObj.text === 'string') {
        out += itemObj.text;
      }
    }
    if (out.length > 0) return { text: out };
  }

  return null;
}

