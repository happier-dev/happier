import { PLUGIN_MANIFEST } from '../manifest.js';

/**
 * Narrows a dynamic Resource read to the text payload the Channels Resources
 * actually publish. The generic Resource contract also permits bytes, so this
 * fails loudly if one of these Resources ever stops answering JSON text
 * instead of silently handing a `Uint8Array` to `JSON.parse`.
 */
export function resourceText(content: string | Uint8Array): string {
  if (typeof content !== 'string') {
    throw new Error('Expected the Channels Resource to answer JSON text, received bytes.');
  }
  return content;
}

/**
 * Reads the declared byte ceiling for one manifest Resource. Tests compare a
 * real projection against this exact declaration, so a missing contribution or
 * a non-numeric ceiling is a manifest defect and fails here rather than
 * degrading the comparison to `undefined`.
 */
export function declaredResourceMaxBytes(resourceId: string): number {
  const declared = PLUGIN_MANIFEST.contributes?.resources?.find(
    (resource) => resource.id === resourceId,
  );
  if (declared === undefined) {
    throw new Error(`Expected the ${resourceId} Resource declaration.`);
  }
  const { maxBytes } = declared;
  if (typeof maxBytes !== 'number') {
    throw new Error(`Expected the ${resourceId} Resource to declare a numeric maxBytes.`);
  }
  return maxBytes;
}
