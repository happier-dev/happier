import type { Messages } from './en';

/**
 * French copy for the marketing site.
 *
 * REGISTER — TUTOIEMENT. Happier addresses the reader as `tu`, matching the
 * shipped app and the way French dev tooling actually speaks. « Vous » would
 * read as a bank letter next to an English page written in the second person.
 *
 * Terms deliberately left in English because that is what French developers
 * say: relay, CLI, Git, MCP, prompt, skill, subagent, session, backend,
 * worktree, bare metal, open source, changelog, QR code, Docker, Tailscale, and
 * every provider name (Claude Code, Codex, OpenCode, Pi). Only `repository`
 * ("dépôt") and `branch` ("branche") are francised, per the glossary.
 *
 * TYPOGRAPHY. Typographic apostrophe ’ (U+2019) everywhere, and a NARROW
 * NO-BREAK SPACE (U+202F) before `?` `!` `:` `;` — e.g. "Copié !" and the colon
 * in `selfHost.operationBody`. They look like ordinary spaces in a diff; they
 * are not, and stripping them is a typography regression rather than a
 * whitespace cleanup.
 *
 * STATUS: machine-authored, glossary-anchored, NOT yet reviewed by a native
 * speaker. See the review gate in the lane notes before this ships to /fr.
 */
export const fr: Messages = {
    meta: {
        title: 'Happier — Une session. Tous tes appareils.',
        description:
            'Happier est la salle de contrôle multi-appareils de tes agents de code IA. Fais tourner Claude Code, Codex, OpenCode et bien d’autres — sur tous tes appareils, dans une seule boîte de réception, avec tes propres abonnements.',
        ogTitle: 'Happier — Une session. Tous tes appareils.',
        ogDescription:
            'La couche de contrôle mobile de tes agents de code IA. Tu vois l’interface. Tu agis dessus. Sans bricolage.',
        // Open Graph wants language_TERRITORY, and it must match LOCALE_META.fr.
        ogLocale: 'fr_FR',
    },

    nav: {
        github: 'GitHub',
        // "Star" is the verb French developers use for this button; « Mettre une
        // étoile sur GitHub » is both longer than the nav slot and colder.
        starOnGithub: 'Star sur GitHub',
        docs: 'Docs',
        guides: 'Guides',
        webApp: 'Appli web',
        localeSwitcherLabel: 'Changer de langue',
    },


    install: {
        copy: 'Copier',
        copied: 'Copié !',
        copyCommand: 'Copier la commande d’installation',
    },

    badges: {
        // Eyebrow + label stack: "Télécharger sur" / "App Store".
        appStoreEyebrow: 'Télécharger sur',
        appStoreLabel: 'App Store',
        playEyebrow: 'Disponible sur',
        playLabel: 'Google Play',
        // EN splits "Open the" / "Web app"; French cannot carry the elided
        // article across the two lines, so the eyebrow is the bare verb.
        webAppEyebrow: 'Ouvrir',
        webAppLabel: 'Appli web',
    },

    features: {
        heading: 'Une seule salle de contrôle\npour tous tes agents de code.',
    },

    explorer: {
        heading: 'Tous les outils.\nUne seule interface.',
        tabChat: 'Chat',
        tabEditor: 'Éditeur',
        tabGit: 'Git',
        tabTerminal: 'Terminal',
    },

    grid: {
        heading: 'Tout le reste,\ndont tu ignorais avoir besoin.',
    },

    selfHost: {
        heading: 'Maîtrise toute la stack.\nReste indépendant.',
        installTitle: 'Installation en une commande',
        installBody:
            'Installe le serveur relay avec une seule commande. Docker ou bare metal.',
        operationTitle: 'Au quotidien',
        // L’original disait « mises à jour automatiques intégrées », ce que nos
        // propres docs contredisent (docker.mdx:41,72 ; advanced/updates.mdx:156 ;
        // hstack/remote-server.mdx:86). À garder aligné avec HIGHLIGHTS dans
        // src/sections/SelfHost.tsx.
        operationBody:
            'Un service géré que tu démarres, arrêtes et surveilles avec happier relay host status. Rien ne se met à jour tout seul sur l’hôte : tu mets à jour en relançant la commande d’installation, quand tu le décides.',
        remoteTitle: 'Accès à distance',
        remoteBody:
            'Accède à tes sessions depuis n’importe où. Tunnels SSH, Tailscale ou HTTPS direct.',
        nodeDevice: 'Ton appareil',
        nodeRelay: 'Ton relay',
        nodeRelayDetail: 'Docker ou bare metal',
        nodeMachine: 'Ta machine',
        nodeMachineDetail: 'Claude Code, Codex, OpenCode',
        copyCommands: 'Copier les commandes',
        copy: 'Copier',
        copied: 'Copié !',
    },

    getStarted: {
        heading: 'Opérationnel\nen moins d’une minute.',
        stepDownloadTitle: 'Télécharge l’app',
        stepDownloadBody:
            'Récupère Happier sur l’App Store, sur Google Play ou en version desktop.',
        stepInstallTitle: 'Installe le CLI',
        stepInstallBody: 'Une seule commande. Sur macOS, Linux et Windows.',
        // « Associe » plutôt que « appaire » : c’est le verbe que l’app utilise
        // déjà pour le même geste.
        stepPairTitle: 'Associe ton appareil',
        stepPairBody:
            'Scanne le QR code affiché dans ton terminal pour connecter ton téléphone ou ton navigateur.',
        stepCodeTitle: 'Commence à coder',
        stepCodeBody:
            'Lance happier au lieu de claude ou codex. Tes sessions se synchronisent partout, instantanément.',
        runHappierLabel: 'Lance happier au lieu de claude',
    },

    cta: {
        heading: 'Open source. À toi pour toujours.',
    },

    footer: {
        columnProduct: 'Produit',
        columnOpenSource: 'Open source',
        columnResources: 'Ressources',
        linkFeatures: 'Fonctionnalités',
        linkGetStarted: 'Démarrer',
        linkWebApp: 'Appli web',
        linkDocs: 'Docs',
        linkGuides: 'Guides',
        linkGithub: 'GitHub',
        linkSelfHost: 'Auto-hébergement',
        linkLicense: 'Licence',
        linkChangelog: 'Changelog',
        linkDiscord: 'Discord',
    },

    localeBanner: {
        body: 'Cette page est disponible en {language}.',
        action: 'Changer',
        dismiss: 'Fermer',
    },
};
