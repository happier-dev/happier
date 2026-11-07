import { expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';

it('declares the same exact resource in app and Session destinations', () => {
  for (const kind of ['app', 'session']) {
    const view = PLUGIN_MANIFEST.contributes.ui.views.find(view => view.container === 'scmPullRequest' && view.target.kind === kind)!;
    for (const [resourceKind, path] of [['pullRequest', 'pull/3'], ['issue', 'issues/4'], ['securityAlert', 'security/dependabot/5'], ['securityAlert', 'security/code-scanning/6']]) {
      const link = view.resourceLinks?.find(link => link.kind === resourceKind && new RegExp(link.urlPattern).test(`https://github.com/octo/repo/${path}/?tab=checks#comment`));
      expect(link, `${kind} ${path}`).toBeDefined();
      const destination = PLUGIN_MANIFEST.contributes.ui.views.find(candidate => candidate.id === link!.destination)!;
      expect(destination).toMatchObject({ target: { kind }, container: kind === 'app' ? 'appPage' : 'detailsTab' });
      expect(new RegExp(link!.urlPattern).test(`https://github.com.evil/octo/repo/${path}`)).toBe(false);
    }
  }
});
