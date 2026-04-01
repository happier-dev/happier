// @ts-check

/**
 * Docker publish channels are a small, intentionally separate set from the general release rings.
 * They control:
 * - image tags (`:stable`, `:preview`, `:dev`)
 * - embedded policy env baked into the image
 *
 * Public dev (`dev`) uses preview-like embedded policy and is intended for side-by-side installs.
 *
 * @typedef {'stable' | 'preview' | 'dev'} DockerChannel
 */

/**
 * @param {unknown} raw
 * @returns {raw is DockerChannel}
 */
export function isDockerChannel(raw) {
  const v = String(raw ?? '').trim();
  return v === 'stable' || v === 'preview' || v === 'dev';
}

/**
 * @param {unknown} raw
 * @returns {DockerChannel}
 */
export function assertDockerChannel(raw) {
  const v = String(raw ?? '').trim();
  if (isDockerChannel(v)) return v;
  throw new Error(`[pipeline] docker channel must be 'stable', 'preview', or 'dev' (got: ${v || '<empty>'})`);
}

