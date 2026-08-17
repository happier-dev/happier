/**
 * The stable Bitbucket plugin identities that both the manifest and its runtime modules need.
 *
 * They live in their own module because the manifest declares the SCM hosting provider and the
 * adapter derives its qualified provider id from the plugin id: importing one from the other makes
 * a cycle whose evaluation order decides whether a top-level constant is defined, which is a
 * defect that surfaces as an undefined manifest rather than as an import error.
 */
export const BITBUCKET_PLUGIN_ID = 'happier.scm.forge.bitbucket';

/** The plugin-local id of the one contributed SCM hosting provider. */
export const BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID = 'bitbucket';

/** The host-qualified id the same contribution is addressed by outside this plugin. */
export const BITBUCKET_SCM_HOSTING_PROVIDER_ID =
  `${BITBUCKET_PLUGIN_ID}/${BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID}`;
