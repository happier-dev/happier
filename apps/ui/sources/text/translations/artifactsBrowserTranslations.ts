/**
 * Copy for the Artifacts browser (RU2 §9.6): the rail destination's page, its toolbar, cards and
 * rows, the artifact view, its history and the storage budget. Sharing words live in
 * `shareSheetTranslations` (documents adapter).
 */
type ArtifactsBrowserTranslations = Readonly<{
    description: string;
    newDocument: string;
    searchPlaceholder: string;
    kindLabel: string;
    kinds: Readonly<{
        all: string;
        document: string;
        prompt: string;
        board: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    kindOne: Readonly<{
        document: string;
        prompt: string;
        board: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    sort: Readonly<{
        label: string;
        updated_desc: string;
        created_desc: string;
        title_asc: string;
    }>;
    view: Readonly<{
        label: string;
        grid: string;
        list: string;
    }>;
    provenance: Readonly<{
        savedByYou: string;
        sharedWithYou: string;
        fromFile: (params: Readonly<{ name: string }>) => string;
        openSession: (params: Readonly<{ session: string }>) => string;
    }>;
    emptyTitle: string;
    emptyBody: string;
    emptyHint: string;
    loadFailedTitle: string;
    loadFailedBody: string;
    quota: Readonly<{
        accountTitle: string;
        documentTitle: string;
        accountBody: (params: Readonly<{ used: string; limit: string }>) => string;
        documentBody: (params: Readonly<{ size: string; limit: string }>) => string;
    }>;
    open: Readonly<{
        document: string;
        prompt: string;
        board: string;
        workflow: string;
        role: string;
        launchProfile: string;
    }>;
    openAsPage: string;
    actions: Readonly<{
        edit: string;
        history: string;
        share: string;
        more: string;
        copyLink: string;
        linkCopied: string;
    }>;
    history: Readonly<{
        title: string;
        current: string;
        now: string;
        restoreNote: string;
        loadFailed: string;
        empty: string;
        versionsLabel: string;
        restoreFailed: string;
        savedByUser: string;
        savedByAgentSession: string;
        restoredVersion: (params: Readonly<{ n: number }>) => string;
        version: (params: Readonly<{ n: number }>) => string;
        keeps: (params: Readonly<{ count: number }>) => string;
        restore: (params: Readonly<{ n: number }>) => string;
    }>;
    savedToday: (params: Readonly<{ count: number }>) => string;
    noMatch: (params: Readonly<{ query: string }>) => string;
    storage: Readonly<{
        meter: (params: Readonly<{ used: string; limit: string }>) => string;
        a11y: (params: Readonly<{ used: string; limit: string }>) => string;
    }>;
    facts: Readonly<{
        edited: (params: Readonly<{ age: string }>) => string;
    }>;
}>;

export const artifactsBrowserTranslations = {
    en: {
        description: 'What you and your agents saved — ready to read, reuse and share.',
        newDocument: 'New document',
        searchPlaceholder: 'Search artifacts',
        kindLabel: 'Kind',
        kinds: {
            all: 'All kinds',
            document: 'Documents',
            prompt: 'Prompts',
            board: 'Boards',
            workflow: 'Workflows',
            role: 'Roles',
            launchProfile: 'Launch profiles',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            board: 'Board',
            workflow: 'Workflow',
            role: 'Role',
            launchProfile: 'Launch profile',
        },
        sort: {
            label: 'Sort',
            updated_desc: 'Recently updated',
            created_desc: 'Recently created',
            title_asc: 'Title',
        },
        view: {
            label: 'View',
            grid: 'Grid',
            list: 'List',
        },
        provenance: {
            savedByYou: 'Saved by you',
            sharedWithYou: 'Shared with you',
            fromFile: ({ name }) => `From ${name}`,
            openSession: ({ session }) => `Open ${session}`,
        },
        emptyTitle: 'Keep what your agents make',
        emptyBody: 'Plans, notes, code and boards you or your agents save land here — readable on every device and ready to share with your Teams.',
        emptyHint: 'Or ask an agent to “save that as an artifact”.',
        loadFailedTitle: 'Couldn’t load your artifacts',
        loadFailedBody: 'Check your connection, then try again. Nothing was lost.',
        quota: {
            accountTitle: 'Artifact storage is full',
            documentTitle: 'Too large to save',
            accountBody: ({ used, limit }) => `${used} of ${limit} used, versions included. Delete or export artifacts you no longer need to save new ones.`,
            documentBody: ({ size, limit }) => `This would be ${size}; each artifact can hold up to ${limit}. Your edits are still here.`,
        },
        open: {
            document: 'Open document',
            prompt: 'Open prompt',
            board: 'Open board',
            workflow: 'Open workflow',
            role: 'Open role',
            launchProfile: 'Open launch profile',
        },
        openAsPage: 'Open as page',
        actions: {
            edit: 'Edit',
            history: 'History',
            share: 'Share',
            more: 'More actions',
            copyLink: 'Copy link',
            linkCopied: 'Link copied',
        },
        history: {
            title: 'History',
            current: 'Current',
            now: 'Now',
            restoreNote: 'Restoring adds it as a new version. Nothing is lost.',
            loadFailed: 'Couldn’t load the history. Try again.',
            empty: 'No earlier versions yet. Each save keeps one.',
            versionsLabel: 'Versions',
            restoreFailed: 'Couldn’t restore this version. Try again.',
            savedByUser: 'Saved by user',
            savedByAgentSession: 'Saved by agent session',
            restoredVersion: ({ n }) => `Restored from version ${n}`,
            version: ({ n }) => `Version ${n}`,
            keeps: ({ count }) => `Keeps the last ${count} versions.`,
            restore: ({ n }) => `Restore version ${n}`,
        },
        savedToday: ({ count }) => `${count} saved today`,
        noMatch: ({ query }) => `No artifacts match “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} of ${limit}`,
            a11y: ({ used, limit }) => `Artifact storage, ${used} of ${limit} used`,
        },
        facts: {
            edited: ({ age }) => `Edited ${age}`,
        },
    },
    fr: {
        description: 'Ce que vous et vos agents avez enregistré — prêt à lire, réutiliser et partager.',
        newDocument: 'Nouveau document',
        searchPlaceholder: 'Rechercher des artefacts',
        kindLabel: 'Type',
        kinds: {
            all: 'Tous les types',
            document: 'Documents',
            prompt: 'Prompts',
            board: 'Tableaux',
            workflow: 'Workflows',
            role: 'Rôles',
            launchProfile: 'Profils de lancement',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            board: 'Tableau',
            workflow: 'Workflow',
            role: 'Rôle',
            launchProfile: 'Profil de lancement',
        },
        sort: {
            label: 'Trier',
            updated_desc: 'Modifiés récemment',
            created_desc: 'Créés récemment',
            title_asc: 'Titre',
        },
        view: {
            label: 'Affichage',
            grid: 'Grille',
            list: 'Liste',
        },
        provenance: {
            savedByYou: 'Enregistré par vous',
            sharedWithYou: 'Partagé avec vous',
            fromFile: ({ name }) => `Depuis ${name}`,
            openSession: ({ session }) => `Ouvrir ${session}`,
        },
        emptyTitle: 'Gardez ce que vos agents créent',
        emptyBody: 'Les plans, notes, code et tableaux que vous ou vos agents enregistrez arrivent ici — lisibles sur tous vos appareils et prêts à partager avec vos équipes.',
        emptyHint: 'Ou demandez à un agent « enregistre ça comme artefact ».',
        loadFailedTitle: 'Impossible de charger vos artefacts',
        loadFailedBody: 'Vérifiez votre connexion, puis réessayez. Rien n’a été perdu.',
        quota: {
            accountTitle: 'Le stockage des artefacts est plein',
            documentTitle: 'Trop volumineux pour être enregistré',
            accountBody: ({ used, limit }) => `${used} utilisés sur ${limit}, versions comprises. Supprimez ou exportez les artefacts inutiles pour en enregistrer de nouveaux.`,
            documentBody: ({ size, limit }) => `Il ferait ${size} ; chaque artefact peut contenir jusqu’à ${limit}. Vos modifications sont conservées.`,
        },
        open: {
            document: 'Ouvrir le document',
            prompt: 'Ouvrir le prompt',
            board: 'Ouvrir le tableau',
            workflow: 'Ouvrir le workflow',
            role: 'Ouvrir le rôle',
            launchProfile: 'Ouvrir le profil de lancement',
        },
        openAsPage: 'Ouvrir en page',
        actions: {
            edit: 'Modifier',
            history: 'Historique',
            share: 'Partager',
            more: 'Plus d’actions',
            copyLink: 'Copier le lien',
            linkCopied: 'Lien copié',
        },
        history: {
            title: 'Historique',
            current: 'Actuelle',
            now: 'Maintenant',
            restoreNote: 'La restauration l’ajoute comme nouvelle version. Rien n’est perdu.',
            loadFailed: 'Impossible de charger l’historique. Réessayez.',
            empty: 'Pas encore de version antérieure. Chaque enregistrement en garde une.',
            versionsLabel: 'Versions',
            restoreFailed: 'Impossible de restaurer cette version. Réessayez.',
            savedByUser: 'Enregistré par un utilisateur',
            savedByAgentSession: 'Enregistré par une session d’agent',
            restoredVersion: ({ n }) => `Restauré depuis la version ${n}`,
            version: ({ n }) => `Version ${n}`,
            keeps: ({ count }) => `Conserve les ${count} dernières versions.`,
            restore: ({ n }) => `Restaurer la version ${n}`,
        },
        savedToday: ({ count }) => `${count} enregistrés aujourd’hui`,
        noMatch: ({ query }) => `Aucun artefact ne correspond à « ${query} »`,
        storage: {
            meter: ({ used, limit }) => `${used} sur ${limit}`,
            a11y: ({ used, limit }) => `Stockage des artefacts, ${used} utilisés sur ${limit}`,
        },
        facts: {
            edited: ({ age }) => `Modifié ${age}`,
        },
    },
    de: {
        description: 'Was du und deine Agenten gespeichert habt — bereit zum Lesen, Wiederverwenden und Teilen.',
        newDocument: 'Neues Dokument',
        searchPlaceholder: 'Artefakte durchsuchen',
        kindLabel: 'Art',
        kinds: {
            all: 'Alle Arten',
            document: 'Dokumente',
            prompt: 'Prompts',
            board: 'Boards',
            workflow: 'Workflows',
            role: 'Rollen',
            launchProfile: 'Startprofile',
        },
        kindOne: {
            document: 'Dokument',
            prompt: 'Prompt',
            board: 'Board',
            workflow: 'Workflow',
            role: 'Rolle',
            launchProfile: 'Startprofil',
        },
        sort: {
            label: 'Sortieren',
            updated_desc: 'Zuletzt geändert',
            created_desc: 'Zuletzt erstellt',
            title_asc: 'Titel',
        },
        view: {
            label: 'Ansicht',
            grid: 'Raster',
            list: 'Liste',
        },
        provenance: {
            savedByYou: 'Von dir gespeichert',
            sharedWithYou: 'Mit dir geteilt',
            fromFile: ({ name }) => `Aus ${name}`,
            openSession: ({ session }) => `${session} öffnen`,
        },
        emptyTitle: 'Behalte, was deine Agenten erstellen',
        emptyBody: 'Pläne, Notizen, Code und Boards, die du oder deine Agenten speichern, landen hier — auf jedem Gerät lesbar und bereit zum Teilen mit deinen Teams.',
        emptyHint: 'Oder bitte einen Agenten: „Speichere das als Artefakt“.',
        loadFailedTitle: 'Deine Artefakte konnten nicht geladen werden',
        loadFailedBody: 'Prüfe deine Verbindung und versuche es erneut. Nichts ist verloren.',
        quota: {
            accountTitle: 'Der Artefaktspeicher ist voll',
            documentTitle: 'Zu groß zum Speichern',
            accountBody: ({ used, limit }) => `${used} von ${limit} belegt, Versionen eingeschlossen. Lösche oder exportiere Artefakte, die du nicht mehr brauchst, um neue zu speichern.`,
            documentBody: ({ size, limit }) => `Das wären ${size}; jedes Artefakt fasst bis zu ${limit}. Deine Änderungen sind noch da.`,
        },
        open: {
            document: 'Dokument öffnen',
            prompt: 'Prompt öffnen',
            board: 'Board öffnen',
            workflow: 'Workflow öffnen',
            role: 'Rolle öffnen',
            launchProfile: 'Startprofil öffnen',
        },
        openAsPage: 'Als Seite öffnen',
        actions: {
            edit: 'Bearbeiten',
            history: 'Verlauf',
            share: 'Teilen',
            more: 'Weitere Aktionen',
            copyLink: 'Link kopieren',
            linkCopied: 'Link kopiert',
        },
        history: {
            title: 'Verlauf',
            current: 'Aktuell',
            now: 'Jetzt',
            restoreNote: 'Wiederherstellen fügt sie als neue Version hinzu. Nichts geht verloren.',
            loadFailed: 'Der Verlauf konnte nicht geladen werden. Versuche es erneut.',
            empty: 'Noch keine früheren Versionen. Jedes Speichern behält eine.',
            versionsLabel: 'Versionen',
            restoreFailed: 'Diese Version konnte nicht wiederhergestellt werden. Versuche es erneut.',
            savedByUser: 'Von einem Benutzer gespeichert',
            savedByAgentSession: 'Von einer Agentensitzung gespeichert',
            restoredVersion: ({ n }) => `Aus Version ${n} wiederhergestellt`,
            version: ({ n }) => `Version ${n}`,
            keeps: ({ count }) => `Behält die letzten ${count} Versionen.`,
            restore: ({ n }) => `Version ${n} wiederherstellen`,
        },
        savedToday: ({ count }) => `${count} heute gespeichert`,
        noMatch: ({ query }) => `Keine Artefakte passen zu „${query}“`,
        storage: {
            meter: ({ used, limit }) => `${used} von ${limit}`,
            a11y: ({ used, limit }) => `Artefaktspeicher, ${used} von ${limit} belegt`,
        },
        facts: {
            edited: ({ age }) => `Geändert ${age}`,
        },
    },
    es: {
        description: 'Lo que tú y tus agentes guardaron, listo para leer, reutilizar y compartir.',
        newDocument: 'Nuevo documento',
        searchPlaceholder: 'Buscar artefactos',
        kindLabel: 'Tipo',
        kinds: {
            all: 'Todos los tipos',
            document: 'Documentos',
            prompt: 'Prompts',
            board: 'Tableros',
            workflow: 'Flujos de trabajo',
            role: 'Roles',
            launchProfile: 'Perfiles de inicio',
        },
        kindOne: {
            document: 'Documento',
            prompt: 'Prompt',
            board: 'Tablero',
            workflow: 'Flujo de trabajo',
            role: 'Rol',
            launchProfile: 'Perfil de inicio',
        },
        sort: {
            label: 'Ordenar',
            updated_desc: 'Actualizados recientemente',
            created_desc: 'Creados recientemente',
            title_asc: 'Título',
        },
        view: {
            label: 'Vista',
            grid: 'Cuadrícula',
            list: 'Lista',
        },
        provenance: {
            savedByYou: 'Guardado por ti',
            sharedWithYou: 'Compartido contigo',
            fromFile: ({ name }) => `Desde ${name}`,
            openSession: ({ session }) => `Abrir ${session}`,
        },
        emptyTitle: 'Guarda lo que crean tus agentes',
        emptyBody: 'Los planes, notas, código y tableros que tú o tus agentes guardan llegan aquí, legibles en todos tus dispositivos y listos para compartir con tus equipos.',
        emptyHint: 'O pide a un agente “guárdalo como artefacto”.',
        loadFailedTitle: 'No se pudieron cargar tus artefactos',
        loadFailedBody: 'Revisa tu conexión e inténtalo de nuevo. No se perdió nada.',
        quota: {
            accountTitle: 'El almacenamiento de artefactos está lleno',
            documentTitle: 'Demasiado grande para guardar',
            accountBody: ({ used, limit }) => `${used} de ${limit} usados, versiones incluidas. Elimina o exporta los artefactos que ya no necesites para guardar otros nuevos.`,
            documentBody: ({ size, limit }) => `Ocuparía ${size}; cada artefacto admite hasta ${limit}. Tus cambios siguen aquí.`,
        },
        open: {
            document: 'Abrir documento',
            prompt: 'Abrir prompt',
            board: 'Abrir tablero',
            workflow: 'Abrir flujo de trabajo',
            role: 'Abrir rol',
            launchProfile: 'Abrir perfil de inicio',
        },
        openAsPage: 'Abrir como página',
        actions: {
            edit: 'Editar',
            history: 'Historial',
            share: 'Compartir',
            more: 'Más acciones',
            copyLink: 'Copiar enlace',
            linkCopied: 'Enlace copiado',
        },
        history: {
            title: 'Historial',
            current: 'Actual',
            now: 'Ahora',
            restoreNote: 'Restaurar la añade como una versión nueva. No se pierde nada.',
            loadFailed: 'No se pudo cargar el historial. Inténtalo de nuevo.',
            empty: 'Aún no hay versiones anteriores. Cada guardado conserva una.',
            versionsLabel: 'Versiones',
            restoreFailed: 'No se pudo restaurar esta versión. Inténtalo de nuevo.',
            savedByUser: 'Guardado por un usuario',
            savedByAgentSession: 'Guardado por una sesión de agente',
            restoredVersion: ({ n }) => `Restaurado desde la versión ${n}`,
            version: ({ n }) => `Versión ${n}`,
            keeps: ({ count }) => `Conserva las últimas ${count} versiones.`,
            restore: ({ n }) => `Restaurar versión ${n}`,
        },
        savedToday: ({ count }) => `${count} guardados hoy`,
        noMatch: ({ query }) => `Ningún artefacto coincide con “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} de ${limit}`,
            a11y: ({ used, limit }) => `Almacenamiento de artefactos, ${used} de ${limit} usados`,
        },
        facts: {
            edited: ({ age }) => `Editado ${age}`,
        },
    },
    it: {
        description: 'Ciò che tu e i tuoi agenti avete salvato, pronto da leggere, riutilizzare e condividere.',
        newDocument: 'Nuovo documento',
        searchPlaceholder: 'Cerca artefatti',
        kindLabel: 'Tipo',
        kinds: {
            all: 'Tutti i tipi',
            document: 'Documenti',
            prompt: 'Prompt',
            board: 'Bacheche',
            workflow: 'Workflow',
            role: 'Ruoli',
            launchProfile: 'Profili di avvio',
        },
        kindOne: {
            document: 'Documento',
            prompt: 'Prompt',
            board: 'Bacheca',
            workflow: 'Workflow',
            role: 'Ruolo',
            launchProfile: 'Profilo di avvio',
        },
        sort: {
            label: 'Ordina',
            updated_desc: 'Aggiornati di recente',
            created_desc: 'Creati di recente',
            title_asc: 'Titolo',
        },
        view: {
            label: 'Vista',
            grid: 'Griglia',
            list: 'Elenco',
        },
        provenance: {
            savedByYou: 'Salvato da te',
            sharedWithYou: 'Condiviso con te',
            fromFile: ({ name }) => `Da ${name}`,
            openSession: ({ session }) => `Apri ${session}`,
        },
        emptyTitle: 'Conserva ciò che creano i tuoi agenti',
        emptyBody: 'Piani, note, codice e bacheche che tu o i tuoi agenti salvate arrivano qui, leggibili su ogni dispositivo e pronti da condividere con i tuoi team.',
        emptyHint: 'Oppure chiedi a un agente “salvalo come artefatto”.',
        loadFailedTitle: 'Impossibile caricare i tuoi artefatti',
        loadFailedBody: 'Controlla la connessione e riprova. Non è andato perso nulla.',
        quota: {
            accountTitle: 'Lo spazio per gli artefatti è pieno',
            documentTitle: 'Troppo grande per essere salvato',
            accountBody: ({ used, limit }) => `${used} di ${limit} usati, versioni incluse. Elimina o esporta gli artefatti che non ti servono più per salvarne di nuovi.`,
            documentBody: ({ size, limit }) => `Occuperebbe ${size}; ogni artefatto può contenere fino a ${limit}. Le tue modifiche sono ancora qui.`,
        },
        open: {
            document: 'Apri documento',
            prompt: 'Apri prompt',
            board: 'Apri bacheca',
            workflow: 'Apri workflow',
            role: 'Apri ruolo',
            launchProfile: 'Apri profilo di avvio',
        },
        openAsPage: 'Apri come pagina',
        actions: {
            edit: 'Modifica',
            history: 'Cronologia',
            share: 'Condividi',
            more: 'Altre azioni',
            copyLink: 'Copia link',
            linkCopied: 'Link copiato',
        },
        history: {
            title: 'Cronologia',
            current: 'Attuale',
            now: 'Ora',
            restoreNote: 'Il ripristino la aggiunge come nuova versione. Non si perde nulla.',
            loadFailed: 'Impossibile caricare la cronologia. Riprova.',
            empty: 'Nessuna versione precedente. Ogni salvataggio ne conserva una.',
            versionsLabel: 'Versioni',
            restoreFailed: 'Impossibile ripristinare questa versione. Riprova.',
            savedByUser: 'Salvato da un utente',
            savedByAgentSession: 'Salvato da una sessione agente',
            restoredVersion: ({ n }) => `Ripristinato dalla versione ${n}`,
            version: ({ n }) => `Versione ${n}`,
            keeps: ({ count }) => `Conserva le ultime ${count} versioni.`,
            restore: ({ n }) => `Ripristina versione ${n}`,
        },
        savedToday: ({ count }) => `${count} salvati oggi`,
        noMatch: ({ query }) => `Nessun artefatto corrisponde a “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} di ${limit}`,
            a11y: ({ used, limit }) => `Spazio artefatti, ${used} di ${limit} usati`,
        },
        facts: {
            edited: ({ age }) => `Modificato ${age}`,
        },
    },
    pt: {
        description: 'O que você e seus agentes salvaram, pronto para ler, reutilizar e compartilhar.',
        newDocument: 'Novo documento',
        searchPlaceholder: 'Pesquisar artefatos',
        kindLabel: 'Tipo',
        kinds: {
            all: 'Todos os tipos',
            document: 'Documentos',
            prompt: 'Prompts',
            board: 'Quadros',
            workflow: 'Fluxos de trabalho',
            role: 'Funções',
            launchProfile: 'Perfis de início',
        },
        kindOne: {
            document: 'Documento',
            prompt: 'Prompt',
            board: 'Quadro',
            workflow: 'Fluxo de trabalho',
            role: 'Função',
            launchProfile: 'Perfil de início',
        },
        sort: {
            label: 'Ordenar',
            updated_desc: 'Atualizados recentemente',
            created_desc: 'Criados recentemente',
            title_asc: 'Título',
        },
        view: {
            label: 'Visualização',
            grid: 'Grade',
            list: 'Lista',
        },
        provenance: {
            savedByYou: 'Salvo por você',
            sharedWithYou: 'Compartilhado com você',
            fromFile: ({ name }) => `De ${name}`,
            openSession: ({ session }) => `Abrir ${session}`,
        },
        emptyTitle: 'Guarde o que seus agentes criam',
        emptyBody: 'Planos, notas, código e quadros que você ou seus agentes salvam chegam aqui, legíveis em qualquer dispositivo e prontos para compartilhar com suas equipes.',
        emptyHint: 'Ou peça a um agente “salve isso como artefato”.',
        loadFailedTitle: 'Não foi possível carregar seus artefatos',
        loadFailedBody: 'Verifique sua conexão e tente novamente. Nada foi perdido.',
        quota: {
            accountTitle: 'O armazenamento de artefatos está cheio',
            documentTitle: 'Grande demais para salvar',
            accountBody: ({ used, limit }) => `${used} de ${limit} usados, incluindo versões. Exclua ou exporte artefatos de que não precisa mais para salvar novos.`,
            documentBody: ({ size, limit }) => `Ficaria com ${size}; cada artefato comporta até ${limit}. Suas edições continuam aqui.`,
        },
        open: {
            document: 'Abrir documento',
            prompt: 'Abrir prompt',
            board: 'Abrir quadro',
            workflow: 'Abrir fluxo de trabalho',
            role: 'Abrir função',
            launchProfile: 'Abrir perfil de início',
        },
        openAsPage: 'Abrir como página',
        actions: {
            edit: 'Editar',
            history: 'Histórico',
            share: 'Compartilhar',
            more: 'Mais ações',
            copyLink: 'Copiar link',
            linkCopied: 'Link copiado',
        },
        history: {
            title: 'Histórico',
            current: 'Atual',
            now: 'Agora',
            restoreNote: 'Restaurar a adiciona como uma nova versão. Nada é perdido.',
            loadFailed: 'Não foi possível carregar o histórico. Tente novamente.',
            empty: 'Ainda não há versões anteriores. Cada salvamento guarda uma.',
            versionsLabel: 'Versões',
            restoreFailed: 'Não foi possível restaurar esta versão. Tente novamente.',
            savedByUser: 'Salvo por um usuário',
            savedByAgentSession: 'Salvo por uma sessão de agente',
            restoredVersion: ({ n }) => `Restaurado da versão ${n}`,
            version: ({ n }) => `Versão ${n}`,
            keeps: ({ count }) => `Mantém as últimas ${count} versões.`,
            restore: ({ n }) => `Restaurar versão ${n}`,
        },
        savedToday: ({ count }) => `${count} salvos hoje`,
        noMatch: ({ query }) => `Nenhum artefato corresponde a “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} de ${limit}`,
            a11y: ({ used, limit }) => `Armazenamento de artefatos, ${used} de ${limit} usados`,
        },
        facts: {
            edited: ({ age }) => `Editado ${age}`,
        },
    },
    ca: {
        description: 'El que tu i els teus agents heu desat, a punt per llegir, reutilitzar i compartir.',
        newDocument: 'Document nou',
        searchPlaceholder: 'Cerca artefactes',
        kindLabel: 'Tipus',
        kinds: {
            all: 'Tots els tipus',
            document: 'Documents',
            prompt: 'Prompts',
            board: 'Taulers',
            workflow: 'Fluxos de treball',
            role: 'Rols',
            launchProfile: 'Perfils d’inici',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            board: 'Tauler',
            workflow: 'Flux de treball',
            role: 'Rol',
            launchProfile: 'Perfil d’inici',
        },
        sort: {
            label: 'Ordena',
            updated_desc: 'Actualitzats recentment',
            created_desc: 'Creats recentment',
            title_asc: 'Títol',
        },
        view: {
            label: 'Vista',
            grid: 'Quadrícula',
            list: 'Llista',
        },
        provenance: {
            savedByYou: 'Desat per tu',
            sharedWithYou: 'Compartit amb tu',
            fromFile: ({ name }) => `De ${name}`,
            openSession: ({ session }) => `Obre ${session}`,
        },
        emptyTitle: 'Conserva el que creen els teus agents',
        emptyBody: 'Els plans, notes, codi i taulers que tu o els teus agents deseu arriben aquí, llegibles a tots els dispositius i a punt per compartir amb els teus equips.',
        emptyHint: 'O demana a un agent “desa-ho com a artefacte”.',
        loadFailedTitle: 'No s’han pogut carregar els teus artefactes',
        loadFailedBody: 'Comprova la connexió i torna-ho a provar. No s’ha perdut res.',
        quota: {
            accountTitle: 'L’emmagatzematge d’artefactes és ple',
            documentTitle: 'Massa gran per desar',
            accountBody: ({ used, limit }) => `${used} de ${limit} usats, versions incloses. Suprimeix o exporta els artefactes que ja no necessitis per desar-ne de nous.`,
            documentBody: ({ size, limit }) => `Ocuparia ${size}; cada artefacte admet fins a ${limit}. Els teus canvis encara hi són.`,
        },
        open: {
            document: 'Obre el document',
            prompt: 'Obre el prompt',
            board: 'Obre el tauler',
            workflow: 'Obre el flux de treball',
            role: 'Obre el rol',
            launchProfile: 'Obre el perfil d’inici',
        },
        openAsPage: 'Obre com a pàgina',
        actions: {
            edit: 'Edita',
            history: 'Historial',
            share: 'Comparteix',
            more: 'Més accions',
            copyLink: 'Copia l’enllaç',
            linkCopied: 'Enllaç copiat',
        },
        history: {
            title: 'Historial',
            current: 'Actual',
            now: 'Ara',
            restoreNote: 'Restaurar-la l’afegeix com a versió nova. No es perd res.',
            loadFailed: 'No s’ha pogut carregar l’historial. Torna-ho a provar.',
            empty: 'Encara no hi ha versions anteriors. Cada desament en conserva una.',
            versionsLabel: 'Versions',
            restoreFailed: 'No s’ha pogut restaurar aquesta versió. Torna-ho a provar.',
            savedByUser: 'Desat per un usuari',
            savedByAgentSession: 'Desat per una sessió d’agent',
            restoredVersion: ({ n }) => `Restaurat des de la versió ${n}`,
            version: ({ n }) => `Versió ${n}`,
            keeps: ({ count }) => `Conserva les últimes ${count} versions.`,
            restore: ({ n }) => `Restaura la versió ${n}`,
        },
        savedToday: ({ count }) => `${count} desats avui`,
        noMatch: ({ query }) => `Cap artefacte coincideix amb “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} de ${limit}`,
            a11y: ({ used, limit }) => `Emmagatzematge d’artefactes, ${used} de ${limit} usats`,
        },
        facts: {
            edited: ({ age }) => `Editat ${age}`,
        },
    },
    ru: {
        description: 'То, что сохранили вы и ваши агенты, — готово к чтению, повторному использованию и отправке.',
        newDocument: 'Новый документ',
        searchPlaceholder: 'Поиск артефактов',
        kindLabel: 'Тип',
        kinds: {
            all: 'Все типы',
            document: 'Документы',
            prompt: 'Промпты',
            board: 'Доски',
            workflow: 'Рабочие процессы',
            role: 'Роли',
            launchProfile: 'Профили запуска',
        },
        kindOne: {
            document: 'Документ',
            prompt: 'Промпт',
            board: 'Доска',
            workflow: 'Рабочий процесс',
            role: 'Роль',
            launchProfile: 'Профиль запуска',
        },
        sort: {
            label: 'Сортировка',
            updated_desc: 'Недавно изменённые',
            created_desc: 'Недавно созданные',
            title_asc: 'Название',
        },
        view: {
            label: 'Вид',
            grid: 'Сетка',
            list: 'Список',
        },
        provenance: {
            savedByYou: 'Сохранено вами',
            sharedWithYou: 'Доступно вам',
            fromFile: ({ name }) => `Из ${name}`,
            openSession: ({ session }) => `Открыть ${session}`,
        },
        emptyTitle: 'Сохраняйте то, что создают агенты',
        emptyBody: 'Планы, заметки, код и доски, которые сохраняете вы или агенты, появляются здесь — их можно читать на любом устройстве и отправлять командам.',
        emptyHint: 'Или попросите агента «сохрани это как артефакт».',
        loadFailedTitle: 'Не удалось загрузить артефакты',
        loadFailedBody: 'Проверьте подключение и повторите попытку. Ничего не потеряно.',
        quota: {
            accountTitle: 'Хранилище артефактов заполнено',
            documentTitle: 'Слишком большой для сохранения',
            accountBody: ({ used, limit }) => `Использовано ${used} из ${limit} с учётом версий. Удалите или экспортируйте ненужные артефакты, чтобы сохранять новые.`,
            documentBody: ({ size, limit }) => `Получится ${size}; в одном артефакте помещается до ${limit}. Ваши правки сохранены.`,
        },
        open: {
            document: 'Открыть документ',
            prompt: 'Открыть промпт',
            board: 'Открыть доску',
            workflow: 'Открыть процесс',
            role: 'Открыть роль',
            launchProfile: 'Открыть профиль запуска',
        },
        openAsPage: 'Открыть как страницу',
        actions: {
            edit: 'Изменить',
            history: 'История',
            share: 'Поделиться',
            more: 'Другие действия',
            copyLink: 'Скопировать ссылку',
            linkCopied: 'Ссылка скопирована',
        },
        history: {
            title: 'История',
            current: 'Текущая',
            now: 'Сейчас',
            restoreNote: 'Восстановление добавит её как новую версию. Ничего не потеряется.',
            loadFailed: 'Не удалось загрузить историю. Повторите попытку.',
            empty: 'Предыдущих версий пока нет. Каждое сохранение создаёт новую.',
            versionsLabel: 'Версии',
            restoreFailed: 'Не удалось восстановить эту версию. Повторите попытку.',
            savedByUser: 'Сохранено пользователем',
            savedByAgentSession: 'Сохранено сессией агента',
            restoredVersion: ({ n }) => `Восстановлено из версии ${n}`,
            version: ({ n }) => `Версия ${n}`,
            keeps: ({ count }) => `Хранятся последние версии: ${count}.`,
            restore: ({ n }) => `Восстановить версию ${n}`,
        },
        savedToday: ({ count }) => `Сегодня сохранено: ${count}`,
        noMatch: ({ query }) => `Нет артефактов по запросу «${query}»`,
        storage: {
            meter: ({ used, limit }) => `${used} из ${limit}`,
            a11y: ({ used, limit }) => `Хранилище артефактов: использовано ${used} из ${limit}`,
        },
        facts: {
            edited: ({ age }) => `Изменено ${age}`,
        },
    },
    pl: {
        description: 'To, co zapisałeś ty i twoi agenci — gotowe do czytania, ponownego użycia i udostępniania.',
        newDocument: 'Nowy dokument',
        searchPlaceholder: 'Szukaj artefaktów',
        kindLabel: 'Rodzaj',
        kinds: {
            all: 'Wszystkie rodzaje',
            document: 'Dokumenty',
            prompt: 'Prompty',
            board: 'Tablice',
            workflow: 'Przepływy pracy',
            role: 'Role',
            launchProfile: 'Profile uruchamiania',
        },
        kindOne: {
            document: 'Dokument',
            prompt: 'Prompt',
            board: 'Tablica',
            workflow: 'Przepływ pracy',
            role: 'Rola',
            launchProfile: 'Profil uruchamiania',
        },
        sort: {
            label: 'Sortuj',
            updated_desc: 'Ostatnio zmienione',
            created_desc: 'Ostatnio utworzone',
            title_asc: 'Tytuł',
        },
        view: {
            label: 'Widok',
            grid: 'Siatka',
            list: 'Lista',
        },
        provenance: {
            savedByYou: 'Zapisane przez ciebie',
            sharedWithYou: 'Udostępnione tobie',
            fromFile: ({ name }) => `Z ${name}`,
            openSession: ({ session }) => `Otwórz ${session}`,
        },
        emptyTitle: 'Zachowaj to, co tworzą twoi agenci',
        emptyBody: 'Plany, notatki, kod i tablice zapisane przez ciebie lub agentów trafiają tutaj — czytelne na każdym urządzeniu i gotowe do udostępnienia zespołom.',
        emptyHint: 'Albo poproś agenta: „zapisz to jako artefakt”.',
        loadFailedTitle: 'Nie udało się wczytać artefaktów',
        loadFailedBody: 'Sprawdź połączenie i spróbuj ponownie. Nic nie zostało utracone.',
        quota: {
            accountTitle: 'Miejsce na artefakty jest pełne',
            documentTitle: 'Za duży, aby zapisać',
            accountBody: ({ used, limit }) => `Użyto ${used} z ${limit}, wliczając wersje. Usuń lub wyeksportuj niepotrzebne artefakty, aby zapisywać nowe.`,
            documentBody: ({ size, limit }) => `Miałby ${size}; każdy artefakt mieści do ${limit}. Twoje zmiany wciąż tu są.`,
        },
        open: {
            document: 'Otwórz dokument',
            prompt: 'Otwórz prompt',
            board: 'Otwórz tablicę',
            workflow: 'Otwórz przepływ pracy',
            role: 'Otwórz rolę',
            launchProfile: 'Otwórz profil uruchamiania',
        },
        openAsPage: 'Otwórz jako stronę',
        actions: {
            edit: 'Edytuj',
            history: 'Historia',
            share: 'Udostępnij',
            more: 'Więcej działań',
            copyLink: 'Kopiuj link',
            linkCopied: 'Skopiowano link',
        },
        history: {
            title: 'Historia',
            current: 'Bieżąca',
            now: 'Teraz',
            restoreNote: 'Przywrócenie doda ją jako nową wersję. Nic nie zostanie utracone.',
            loadFailed: 'Nie udało się wczytać historii. Spróbuj ponownie.',
            empty: 'Brak wcześniejszych wersji. Każdy zapis zachowuje jedną.',
            versionsLabel: 'Wersje',
            restoreFailed: 'Nie udało się przywrócić tej wersji. Spróbuj ponownie.',
            savedByUser: 'Zapisane przez użytkownika',
            savedByAgentSession: 'Zapisane przez sesję agenta',
            restoredVersion: ({ n }) => `Przywrócone z wersji ${n}`,
            version: ({ n }) => `Wersja ${n}`,
            keeps: ({ count }) => `Przechowuje ostatnie wersje: ${count}.`,
            restore: ({ n }) => `Przywróć wersję ${n}`,
        },
        savedToday: ({ count }) => `Zapisane dziś: ${count}`,
        noMatch: ({ query }) => `Brak artefaktów pasujących do „${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} z ${limit}`,
            a11y: ({ used, limit }) => `Miejsce na artefakty: użyto ${used} z ${limit}`,
        },
        facts: {
            edited: ({ age }) => `Zmieniono ${age}`,
        },
    },
    ja: {
        description: 'あなたとエージェントが保存したもの。読む、再利用する、共有する準備ができています。',
        newDocument: '新規ドキュメント',
        searchPlaceholder: 'アーティファクトを検索',
        kindLabel: '種類',
        kinds: {
            all: 'すべての種類',
            document: 'ドキュメント',
            prompt: 'プロンプト',
            board: 'ボード',
            workflow: 'ワークフロー',
            role: 'ロール',
            launchProfile: '起動プロファイル',
        },
        kindOne: {
            document: 'ドキュメント',
            prompt: 'プロンプト',
            board: 'ボード',
            workflow: 'ワークフロー',
            role: 'ロール',
            launchProfile: '起動プロファイル',
        },
        sort: {
            label: '並べ替え',
            updated_desc: '最近更新',
            created_desc: '最近作成',
            title_asc: 'タイトル',
        },
        view: {
            label: '表示',
            grid: 'グリッド',
            list: 'リスト',
        },
        provenance: {
            savedByYou: 'あなたが保存',
            sharedWithYou: 'あなたと共有',
            fromFile: ({ name }) => `${name} から`,
            openSession: ({ session }) => `${session} を開く`,
        },
        emptyTitle: 'エージェントが作ったものを残そう',
        emptyBody: 'あなたやエージェントが保存した計画、メモ、コード、ボードがここに集まります。どのデバイスでも読め、チームとすぐ共有できます。',
        emptyHint: 'またはエージェントに「それをアーティファクトとして保存して」と頼んでください。',
        loadFailedTitle: 'アーティファクトを読み込めませんでした',
        loadFailedBody: '接続を確認してもう一度お試しください。何も失われていません。',
        quota: {
            accountTitle: 'アーティファクトの保存容量がいっぱいです',
            documentTitle: '大きすぎて保存できません',
            accountBody: ({ used, limit }) => `バージョンを含めて ${limit} 中 ${used} を使用しています。新しく保存するには、不要なアーティファクトを削除またはエクスポートしてください。`,
            documentBody: ({ size, limit }) => `${size} になります。1 つのアーティファクトは最大 ${limit} までです。編集内容はそのまま残っています。`,
        },
        open: {
            document: 'ドキュメントを開く',
            prompt: 'プロンプトを開く',
            board: 'ボードを開く',
            workflow: 'ワークフローを開く',
            role: 'ロールを開く',
            launchProfile: '起動プロファイルを開く',
        },
        openAsPage: 'ページとして開く',
        actions: {
            edit: '編集',
            history: '履歴',
            share: '共有',
            more: 'その他の操作',
            copyLink: 'リンクをコピー',
            linkCopied: 'リンクをコピーしました',
        },
        history: {
            title: '履歴',
            current: '現在',
            now: '現在',
            restoreNote: '復元すると新しいバージョンとして追加されます。何も失われません。',
            loadFailed: '履歴を読み込めませんでした。もう一度お試しください。',
            empty: '以前のバージョンはまだありません。保存するたびに 1 つ残ります。',
            versionsLabel: 'バージョン',
            restoreFailed: 'このバージョンを復元できませんでした。もう一度お試しください。',
            savedByUser: 'ユーザーが保存',
            savedByAgentSession: 'エージェントセッションが保存',
            restoredVersion: ({ n }) => `バージョン${n}から復元`,
            version: ({ n }) => `バージョン ${n}`,
            keeps: ({ count }) => `直近 ${count} 件のバージョンを保持します。`,
            restore: ({ n }) => `バージョン ${n} を復元`,
        },
        savedToday: ({ count }) => `今日 ${count} 件保存`,
        noMatch: ({ query }) => `「${query}」に一致するアーティファクトはありません`,
        storage: {
            meter: ({ used, limit }) => `${limit} 中 ${used}`,
            a11y: ({ used, limit }) => `アーティファクトの保存容量：${limit} 中 ${used} 使用`,
        },
        facts: {
            edited: ({ age }) => `${age} に編集`,
        },
    },
    'zh-Hans': {
        description: '你和你的智能体保存的内容，随时可阅读、复用和分享。',
        newDocument: '新建文档',
        searchPlaceholder: '搜索工件',
        kindLabel: '类型',
        kinds: {
            all: '所有类型',
            document: '文档',
            prompt: '提示词',
            board: '看板',
            workflow: '工作流',
            role: '角色',
            launchProfile: '启动配置',
        },
        kindOne: {
            document: '文档',
            prompt: '提示词',
            board: '看板',
            workflow: '工作流',
            role: '角色',
            launchProfile: '启动配置',
        },
        sort: {
            label: '排序',
            updated_desc: '最近更新',
            created_desc: '最近创建',
            title_asc: '标题',
        },
        view: {
            label: '视图',
            grid: '网格',
            list: '列表',
        },
        provenance: {
            savedByYou: '由你保存',
            sharedWithYou: '与你共享',
            fromFile: ({ name }) => `来自 ${name}`,
            openSession: ({ session }) => `打开 ${session}`,
        },
        emptyTitle: '留住智能体的成果',
        emptyBody: '你或智能体保存的计划、笔记、代码和看板都会出现在这里——在任何设备上都能阅读，并可随时与团队分享。',
        emptyHint: '或者让智能体“把它保存为工件”。',
        loadFailedTitle: '无法加载你的工件',
        loadFailedBody: '请检查网络连接后重试。没有任何内容丢失。',
        quota: {
            accountTitle: '工件存储已满',
            documentTitle: '太大，无法保存',
            accountBody: ({ used, limit }) => `已用 ${used} / ${limit}（含版本）。删除或导出不再需要的工件即可保存新的工件。`,
            documentBody: ({ size, limit }) => `将达到 ${size}；每个工件最多 ${limit}。你的编辑仍然保留。`,
        },
        open: {
            document: '打开文档',
            prompt: '打开提示词',
            board: '打开看板',
            workflow: '打开工作流',
            role: '打开角色',
            launchProfile: '打开启动配置',
        },
        openAsPage: '作为页面打开',
        actions: {
            edit: '编辑',
            history: '历史',
            share: '分享',
            more: '更多操作',
            copyLink: '复制链接',
            linkCopied: '已复制链接',
        },
        history: {
            title: '历史',
            current: '当前',
            now: '现在',
            restoreNote: '恢复会将其添加为新版本，不会丢失任何内容。',
            loadFailed: '无法加载历史记录，请重试。',
            empty: '还没有更早的版本。每次保存都会保留一个。',
            versionsLabel: '版本',
            restoreFailed: '无法恢复此版本，请重试。',
            savedByUser: '由用户保存',
            savedByAgentSession: '由代理会话保存',
            restoredVersion: ({ n }) => `从版本 ${n} 恢复`,
            version: ({ n }) => `版本 ${n}`,
            keeps: ({ count }) => `保留最近 ${count} 个版本。`,
            restore: ({ n }) => `恢复版本 ${n}`,
        },
        savedToday: ({ count }) => `今天保存了 ${count} 个`,
        noMatch: ({ query }) => `没有与“${query}”匹配的工件`,
        storage: {
            meter: ({ used, limit }) => `${used} / ${limit}`,
            a11y: ({ used, limit }) => `工件存储：已用 ${used} / ${limit}`,
        },
        facts: {
            edited: ({ age }) => `${age}编辑`,
        },
    },
    'zh-Hant': {
        description: '你和你的代理儲存的內容，隨時可閱讀、重複使用和分享。',
        newDocument: '新增文件',
        searchPlaceholder: '搜尋成品',
        kindLabel: '類型',
        kinds: {
            all: '所有類型',
            document: '文件',
            prompt: '提示詞',
            board: '看板',
            workflow: '工作流程',
            role: '角色',
            launchProfile: '啟動設定檔',
        },
        kindOne: {
            document: '文件',
            prompt: '提示詞',
            board: '看板',
            workflow: '工作流程',
            role: '角色',
            launchProfile: '啟動設定檔',
        },
        sort: {
            label: '排序',
            updated_desc: '最近更新',
            created_desc: '最近建立',
            title_asc: '標題',
        },
        view: {
            label: '檢視',
            grid: '網格',
            list: '清單',
        },
        provenance: {
            savedByYou: '由你儲存',
            sharedWithYou: '與你共用',
            fromFile: ({ name }) => `來自 ${name}`,
            openSession: ({ session }) => `開啟 ${session}`,
        },
        emptyTitle: '保留代理的成果',
        emptyBody: '你或代理儲存的計畫、筆記、程式碼和看板都會出現在這裡——在任何裝置上都能閱讀，並可隨時與團隊分享。',
        emptyHint: '或請代理「把它儲存為成品」。',
        loadFailedTitle: '無法載入你的成品',
        loadFailedBody: '請檢查網路連線後重試。沒有任何內容遺失。',
        quota: {
            accountTitle: '成品儲存空間已滿',
            documentTitle: '太大，無法儲存',
            accountBody: ({ used, limit }) => `已用 ${used} / ${limit}（含版本）。刪除或匯出不再需要的成品即可儲存新的成品。`,
            documentBody: ({ size, limit }) => `將達到 ${size}；每個成品最多 ${limit}。你的編輯仍然保留。`,
        },
        open: {
            document: '開啟文件',
            prompt: '開啟提示詞',
            board: '開啟看板',
            workflow: '開啟工作流程',
            role: '開啟角色',
            launchProfile: '開啟啟動設定檔',
        },
        openAsPage: '以頁面開啟',
        actions: {
            edit: '編輯',
            history: '歷史',
            share: '分享',
            more: '更多動作',
            copyLink: '複製連結',
            linkCopied: '已複製連結',
        },
        history: {
            title: '歷史',
            current: '目前',
            now: '現在',
            restoreNote: '還原會將其新增為新版本，不會遺失任何內容。',
            loadFailed: '無法載入歷史記錄，請重試。',
            empty: '還沒有更早的版本。每次儲存都會保留一個。',
            versionsLabel: '版本',
            restoreFailed: '無法還原此版本，請重試。',
            savedByUser: '由使用者儲存',
            savedByAgentSession: '由代理工作階段儲存',
            restoredVersion: ({ n }) => `從版本 ${n} 還原`,
            version: ({ n }) => `版本 ${n}`,
            keeps: ({ count }) => `保留最近 ${count} 個版本。`,
            restore: ({ n }) => `還原版本 ${n}`,
        },
        savedToday: ({ count }) => `今天儲存了 ${count} 個`,
        noMatch: ({ query }) => `沒有符合「${query}」的成品`,
        storage: {
            meter: ({ used, limit }) => `${used} / ${limit}`,
            a11y: ({ used, limit }) => `成品儲存空間：已用 ${used} / ${limit}`,
        },
        facts: {
            edited: ({ age }) => `${age}編輯`,
        },
    },
} satisfies Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>;
