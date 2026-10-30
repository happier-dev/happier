import type { ProjectStarterV1 } from './projectStarterV1.js';

/**
 * Source-reviewed 2026-10-27 at the exact pin below:
 * https://github.com/mdn/beginner-html-site-styled/tree/6c7a360ddb4a0d75be06044bf8a914f260ff10c7
 * LICENSE is CC0-1.0. The eight-file whole repository includes index.html,
 * styles/style.css, images/firefox-icon.png and documentation; no build tooling,
 * Dockerfile, Compose or healthcheck. HTML/CSS/image static serving was checked.
 * The preview is original neutral artwork, not Mozilla branding or a screenshot.
 * Preserve upstream history/license; the Session goal replaces its example content
 * and HTTP font reference. Updates require the same pin/license/file/build review.
 */
const staticWebsite = Object.freeze({
  schemaVersion: 1,
  id: 'static-website',
  titleKey: 'projectStarters.staticWebsite.title',
  summaryKey: 'projectStarters.staticWebsite.summary',
  technologyLabels: Object.freeze(['HTML', 'CSS']),
  previewAssetKey: 'project-starter-static-website',
  repository: Object.freeze({
    selector: Object.freeze({
      provider: Object.freeze({
        // Qualified contribution id from scm-github's adapter/manifest owner.
        id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
      }),
      repository: Object.freeze({
        nameWithOwner: 'mdn/beginner-html-site-styled', cloneUrl: 'https://github.com/mdn/beginner-html-site-styled.git',
      }),
      protocol: 'https',
    }),
    ref: '6c7a360ddb4a0d75be06044bf8a914f260ff10c7',
  }),
  buildGoal: 'Build a responsive website from this HTML and CSS example. Replace the sample Mozilla text and logo with original content and use HTTPS for external resources.',
  appShape: 'static',
  deploymentSupport: 'platformOnly',
} satisfies ProjectStarterV1);

const bundledProjectStarters = Object.freeze([staticWebsite]);

/** Static source data retains descriptor/preview identities and performs no reads. */
export function getBundledProjectStartersV1(): readonly ProjectStarterV1[] {
  return bundledProjectStarters;
}

export function resolveBundledProjectStarterV1(id: string): ProjectStarterV1 | null {
  return bundledProjectStarters.find(starter => starter.id === id) ?? null;
}
