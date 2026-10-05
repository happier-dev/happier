/**
 * Copy for Boards (INT §5.1): the Boards destination and its column, the board header and settings,
 * Add to board, the cards, and a pinned board in the Sessions column. Status words come from their
 * owners; the five By status column titles come from the shared status module (`workStatusTranslations`).
 */
type Count = (params: Readonly<{ count: number }>) => string;

type BoardsTranslations = Readonly<{
    title: string;
    newBoard: string;
    defaultName: string;
    index: Readonly<{ title: string; body: string }>;
    notFound: Readonly<{ title: string; body: string }>;
    meta: Readonly<{
        needYou: Count;
        items: Count;
        handPicked: string;
        empty: string;
        moreSources: Count;
    }>;
    sections: Readonly<{
        needs_you: Readonly<{ title: string; description: string }>;
        running: Readonly<{ title: string; description: string }>;
        my_machines: Readonly<{ title: string; description: string }>;
        filter: Readonly<{ title: string; description: string }>;
    }>;
    header: Readonly<{
        layoutA11y: string;
        canvas: string;
        byStatus: string;
        add: string;
        settings: string;
    }>;
    kinds: Readonly<{
        session: string;
        workflow_run: string;
        workflow: string;
        machine: string;
    }>;
    card: Readonly<{
        untitled: string;
        unavailable: string;
        unavailableBody: string;
        notLoaded: string;
        remove: string;
        moveHint: string;
        moved: (params: Readonly<{ x: number; y: number }>) => string;
        /** Screen-reader actions that move a Canvas card one grid step. */
        moveActions: Readonly<{ up: string; down: string; left: string; right: string }>;
        machine: Readonly<{
            online: string;
            offline: string;
            running: Count;
            needYou: Count;
            idle: string;
            offlineBody: string;
        }>;
        workflow: Readonly<{
            noRuns: string;
            lastRun: (params: Readonly<{ word: string; age: string }>) => string;
            needYou: Count;
        }>;
        run: Readonly<{
            waitingForYou: string;
            started: (params: Readonly<{ age: string }>) => string;
        }>;
    }>;
    canvas: Readonly<{
        snapsHere: string;
        snapOnceHint: string;
    }>;
    settings: Readonly<{
        title: string;
        name: string;
        whatsOn: string;
        whichSessions: string;
        addedByHand: string;
        addedByHandNone: string;
        add: string;
        layout: string;
        layoutDescription: string;
        snap: string;
        pin: string;
        pinDescription: string;
        delete: string;
        deleteConfirmTitle: string;
        deleteConfirmBody: string;
    }>;
    add: Readonly<{
        title: string;
        search: string;
        groups: Readonly<{ sessions: string; workflows: string; runs: string; machines: string }>;
        onBoard: string;
        addHint: string;
        addAndPlaceHint: string;
        empty: string;
    }>;
    empty: Readonly<{ title: string; body: string; action: string }>;
    /** Configured widgets on a board (lab `dashboards` L1, G1): the Add group, the card menu and arrivals. */
    widgets: Readonly<{
        /** The group in Add to board and By status. */
        group: string;
        /** What a widget is, spoken after its title. */
        kind: string;
        gallery: string;
        galleryHint: string;
        /** The gallery's line: who sees what you add. */
        addHint: string;
        widthOne: string;
        widthTwo: string;
        moveEarlier: string;
        moveLater: string;
        remove: string;
        /** The widget ⋯'s accessible name. */
        menuA11y: (params: Readonly<{ widget: string }>) => string;
        /** Widgets someone else (an agent) put here while you were looking. */
        arrived: Count;
        undo: string;
        dismiss: string;
    }>;
    saveFailed: Readonly<{
        tooLarge: string;
        notFound: string;
        generic: string;
        retry: string;
        dismiss: string;
        /** The page of a board whose create was refused (it was never made). */
        createTitle: string;
    }>;
}>;

const en: BoardsTranslations = {
    title: 'Boards',
    newBoard: 'New board',
    defaultName: 'Untitled board',
    index: {
        title: 'Your boards',
        body: 'A board keeps sessions, runs, workflows and machines live in one place, arranged your way.',
    },
    notFound: {
        title: 'This board is gone',
        body: 'It was deleted, or it belongs to a Home that is not connected here.',
    },
    meta: {
        needYou: ({ count }) => `${count} need you`,
        items: ({ count }) => (count === 1 ? '1 item' : `${count} items`),
        handPicked: 'Hand-picked',
        empty: 'empty',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Needs you', description: 'Anything waiting on you' },
        running: { title: 'Running now', description: 'Workflow runs in progress' },
        my_machines: { title: 'My machines', description: 'Presence and what runs on each' },
        filter: { title: 'Sessions', description: 'All active sessions' },
    },
    header: {
        layoutA11y: 'Board layout',
        canvas: 'Canvas',
        byStatus: 'By status',
        add: 'Add to board',
        settings: 'Board settings',
    },
    kinds: {
        session: 'Session',
        workflow_run: 'Workflow run',
        workflow: 'Workflow',
        machine: 'Machine',
    },
    card: {
        untitled: 'Unavailable item',
        unavailable: 'Unavailable',
        unavailableBody: 'Its Home is not connected on this device. It stays on the board.',
        notLoaded: 'Not loaded yet',
        remove: 'Remove from board',
        moveHint: 'Arrow keys move this card on the grid.',
        moved: ({ x, y }) => `Moved to ${x}, ${y}`,
        moveActions: { up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 session running' : `${count} sessions running`),
            needYou: ({ count }) => `${count} needs you`,
            idle: 'No sessions running',
            offlineBody: 'Its sessions wait until it is back.',
        },
        workflow: {
            noRuns: 'No runs yet',
            lastRun: ({ word, age }) => `Last run ${age} · ${word}`,
            needYou: ({ count }) => `${count} needs you`,
        },
        run: {
            waitingForYou: 'Waiting for your review',
            started: ({ age }) => `Started ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Snaps here',
        snapOnceHint: 'Hold ⇧ to snap once',
    },
    settings: {
        title: 'Board settings',
        name: 'Name',
        whatsOn: "What's on this board",
        whichSessions: 'Which sessions',
        addedByHand: 'Added by hand',
        addedByHandNone: 'Nothing here yet',
        add: 'Add',
        layout: 'Layout',
        layoutDescription: 'Canvas keeps your arrangement when you switch.',
        snap: 'Snap to grid',
        pin: 'Show in the Sessions list',
        pinDescription: 'Pins this board above your sessions.',
        delete: 'Delete board',
        deleteConfirmTitle: 'Delete this board?',
        deleteConfirmBody: 'Only the board goes. Its sessions, runs, workflows and machines stay as they are.',
    },
    add: {
        title: 'Add to board',
        search: 'Search items',
        groups: { sessions: 'Sessions', workflows: 'Workflows', runs: 'Workflow runs', machines: 'Machines' },
        onBoard: 'On this board',
        addHint: 'Add',
        addAndPlaceHint: 'Add and place',
        empty: 'Nothing matches.',
    },
    empty: {
        title: 'Pick what this board shows',
        body: 'Add sessions, workflows, runs or machines by hand, or show a section such as Needs you. You arrange them; the board keeps them live.',
        action: 'Add to board',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Open the gallery',
        galleryHint: 'Every widget, with a live preview',
        addHint: 'Only you see your boards',
        widthOne: 'One card',
        widthTwo: 'Two cards',
        moveEarlier: 'Move earlier',
        moveLater: 'Move later',
        remove: 'Remove from board',
        menuA11y: ({ widget }) => `${widget} options`,
        arrived: ({ count }) => (count === 1 ? '1 widget arrived just now' : `${count} widgets arrived just now`),
        undo: 'Undo',
        dismiss: 'Dismiss',
    },
    saveFailed: {
        tooLarge: "This board exceeds the Board storage limit. Remove some items, then try again.",
        notFound: 'This board was deleted on another device.',
        generic: "Your change didn't reach your account, so the board is as it was.",
        retry: 'Try again',
        dismiss: 'Dismiss',
        createTitle: "This board wasn't created",
    },
};

const slavicPlural = (count: number, one: string, few: string, many: string): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
};

const ca: BoardsTranslations = {
    title: 'Taulers',
    newBoard: 'Tauler nou',
    defaultName: 'Tauler sense nom',
    index: {
        title: 'Els teus taulers',
        body: 'Un tauler manté sessions, execucions, fluxos de treball i màquines en viu en un sol lloc, organitzats a la teva manera.',
    },
    notFound: {
        title: 'Aquest tauler ja no hi és',
        body: 'S\'ha eliminat, o pertany a una Home que no està connectada aquí.',
    },
    meta: {
        needYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
        items: ({ count }) => (count === 1 ? '1 element' : `${count} elements`),
        handPicked: 'Triats a mà',
        empty: 'Buit',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Et necessita', description: 'Tot el que t\'espera' },
        running: { title: 'En marxa', description: 'Execucions de fluxos de treball en curs' },
        my_machines: { title: 'Les meves màquines', description: 'Presència i què s\'executa a cadascuna' },
        filter: { title: 'Sessions', description: 'Totes les sessions actives' },
    },
    header: {
        layoutA11y: 'Disposició del tauler',
        canvas: 'Llenç',
        byStatus: 'Per estat',
        add: 'Afegeix al tauler',
        settings: 'Configuració del tauler',
    },
    kinds: {
        session: 'Sessió',
        workflow_run: 'Execució de flux de treball',
        workflow: 'Flux de treball',
        machine: 'Màquina',
    },
    card: {
        untitled: 'Element no disponible',
        unavailable: 'No disponible',
        unavailableBody: 'La seva Home no està connectada en aquest dispositiu. Es queda al tauler.',
        notLoaded: 'Encara no s\'ha carregat',
        remove: 'Treu del tauler',
        moveHint: 'Les tecles de fletxa mouen aquesta targeta per la graella.',
        moved: ({ x, y }) => `Mogut a ${x}, ${y}`,
        moveActions: { up: 'Mou amunt', down: 'Mou avall', left: 'Mou a l’esquerra', right: 'Mou a la dreta' },
        machine: {
            online: 'En línia',
            offline: 'Sense connexió',
            running: ({ count }) => (count === 1 ? '1 sessió en marxa' : `${count} sessions en marxa`),
            needYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
            idle: 'Cap sessió en marxa',
            offlineBody: 'Les seves sessions esperen que torni.',
        },
        workflow: {
            noRuns: 'Encara no hi ha execucions',
            lastRun: ({ word, age }) => `Última execució ${age} · ${word}`,
            needYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
        },
        run: {
            waitingForYou: 'Esperant la teva revisió',
            started: ({ age }) => `Iniciada ${age}`,
        },
    },
    canvas: {
        snapsHere: 'S\'ajusta aquí',
        snapOnceHint: 'Mantén ⇧ per ajustar un cop',
    },
    settings: {
        title: 'Configuració del tauler',
        name: 'Nom',
        whatsOn: 'Què hi ha en aquest tauler',
        whichSessions: 'Quines sessions',
        addedByHand: 'Afegit a mà',
        addedByHandNone: 'Encara res',
        add: 'Afegeix',
        layout: 'Disposició',
        layoutDescription: 'El llenç conserva la teva distribució quan canvies.',
        snap: 'Ajusta a la graella',
        pin: 'Mostra a la llista de sessions',
        pinDescription: 'Fixa aquest tauler damunt de les teves sessions.',
        delete: 'Elimina el tauler',
        deleteConfirmTitle: 'Vols eliminar aquest tauler?',
        deleteConfirmBody: 'Només s\'elimina el tauler. Les seves sessions, execucions, fluxos de treball i màquines es queden tal com estan.',
    },
    add: {
        title: 'Afegeix al tauler',
        search: 'Cerca elements',
        groups: { sessions: 'Sessions', workflows: 'Fluxos de treball', runs: 'Execucions de fluxos de treball', machines: 'Màquines' },
        onBoard: 'En aquest tauler',
        addHint: 'Afegeix',
        addAndPlaceHint: 'Afegeix i col·loca',
        empty: 'No hi ha coincidències.',
    },
    empty: {
        title: 'Tria què mostra aquest tauler',
        body: 'Afegeix sessions, fluxos de treball, execucions o màquines a mà, o mostra una secció com Et necessita. Tu els organitzes; el tauler els manté en viu.',
        action: 'Afegeix al tauler',
    },
    widgets: {
        group: 'Ginys',
        kind: 'Giny',
        gallery: 'Obre la galeria',
        galleryHint: 'Tots els ginys, amb una vista prèvia en directe',
        addHint: 'Només tu veus els teus taulers',
        widthOne: 'Una targeta',
        widthTwo: 'Dues targetes',
        moveEarlier: 'Mou abans',
        moveLater: 'Mou després',
        remove: 'Treu del tauler',
        menuA11y: ({ widget }) => `Opcions de ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Ha arribat 1 giny ara mateix' : `Han arribat ${count} ginys ara mateix`),
        undo: 'Desfés',
        dismiss: 'Descarta',
    },
    saveFailed: {
        tooLarge: 'Aquest tauler supera el límit d’emmagatzematge dels taulers. Treu alguns elements i torna-ho a provar.',
        notFound: 'Aquest tauler s\'ha eliminat en un altre dispositiu.',
        generic: 'El canvi no ha arribat al teu compte, així que el tauler es queda com estava.',
        retry: 'Torna-ho a provar',
        dismiss: 'Descarta',
        createTitle: 'Aquest tauler no s’ha creat',
    },
};

const de: BoardsTranslations = {
    title: 'Boards',
    newBoard: 'Neues Board',
    defaultName: 'Unbenanntes Board',
    index: {
        title: 'Deine Boards',
        body: 'Ein Board hält Sitzungen, Läufe, Workflows und Rechner an einem Ort live, so angeordnet, wie du es willst.',
    },
    notFound: {
        title: 'Dieses Board gibt es nicht mehr',
        body: 'Es wurde gelöscht oder gehört zu einem Home, das hier nicht verbunden ist.',
    },
    meta: {
        needYou: ({ count }) => (count === 1 ? '1 braucht dich' : `${count} brauchen dich`),
        items: ({ count }) => (count === 1 ? '1 Element' : `${count} Elemente`),
        handPicked: 'Von Hand gewählt',
        empty: 'Leer',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Braucht dich', description: 'Alles, was auf dich wartet' },
        running: { title: 'Läuft gerade', description: 'Laufende Workflow-Läufe' },
        my_machines: { title: 'Meine Rechner', description: 'Status und was auf jedem läuft' },
        filter: { title: 'Sitzungen', description: 'Alle aktiven Sitzungen' },
    },
    header: {
        layoutA11y: 'Board-Layout',
        canvas: 'Canvas',
        byStatus: 'Nach Status',
        add: 'Zum Board hinzufügen',
        settings: 'Board-Einstellungen',
    },
    kinds: {
        session: 'Sitzung',
        workflow_run: 'Workflow-Lauf',
        workflow: 'Workflow',
        machine: 'Rechner',
    },
    card: {
        untitled: 'Nicht verfügbares Element',
        unavailable: 'Nicht verfügbar',
        unavailableBody: 'Das zugehörige Home ist auf diesem Gerät nicht verbunden. Das Element bleibt auf dem Board.',
        notLoaded: 'Noch nicht geladen',
        remove: 'Vom Board entfernen',
        moveHint: 'Mit den Pfeiltasten verschiebst du diese Karte im Raster.',
        moved: ({ x, y }) => `Verschoben nach ${x}, ${y}`,
        moveActions: { up: 'Nach oben verschieben', down: 'Nach unten verschieben', left: 'Nach links verschieben', right: 'Nach rechts verschieben' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 Sitzung läuft' : `${count} Sitzungen laufen`),
            needYou: ({ count }) => (count === 1 ? '1 braucht dich' : `${count} brauchen dich`),
            idle: 'Keine Sitzung läuft',
            offlineBody: 'Die Sitzungen warten, bis er wieder da ist.',
        },
        workflow: {
            noRuns: 'Noch keine Läufe',
            lastRun: ({ word, age }) => `Letzter Lauf ${age} · ${word}`,
            needYou: ({ count }) => (count === 1 ? '1 braucht dich' : `${count} brauchen dich`),
        },
        run: {
            waitingForYou: 'Wartet auf deine Prüfung',
            started: ({ age }) => `Gestartet ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Rastet hier ein',
        snapOnceHint: '⇧ halten, um einmal einzurasten',
    },
    settings: {
        title: 'Board-Einstellungen',
        name: 'Name',
        whatsOn: 'Was auf diesem Board ist',
        whichSessions: 'Welche Sitzungen',
        addedByHand: 'Von Hand hinzugefügt',
        addedByHandNone: 'Noch nichts',
        add: 'Hinzufügen',
        layout: 'Layout',
        layoutDescription: 'Canvas behält deine Anordnung, wenn du wechselst.',
        snap: 'Am Raster ausrichten',
        pin: 'In der Sitzungsliste anzeigen',
        pinDescription: 'Heftet dieses Board über deine Sitzungen.',
        delete: 'Board löschen',
        deleteConfirmTitle: 'Dieses Board löschen?',
        deleteConfirmBody: 'Nur das Board verschwindet. Seine Sitzungen, Läufe, Workflows und Rechner bleiben, wie sie sind.',
    },
    add: {
        title: 'Zum Board hinzufügen',
        search: 'Elemente suchen',
        groups: { sessions: 'Sitzungen', workflows: 'Workflows', runs: 'Workflow-Läufe', machines: 'Rechner' },
        onBoard: 'Auf diesem Board',
        addHint: 'Hinzufügen',
        addAndPlaceHint: 'Hinzufügen und platzieren',
        empty: 'Nichts passt.',
    },
    empty: {
        title: 'Wähle, was dieses Board zeigt',
        body: 'Füge Sitzungen, Workflows, Läufe oder Rechner von Hand hinzu oder zeige einen Bereich wie „Braucht dich“. Du ordnest sie an; das Board hält sie live.',
        action: 'Zum Board hinzufügen',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Galerie öffnen',
        galleryHint: 'Alle Widgets, mit Live-Vorschau',
        addHint: 'Nur du siehst deine Boards',
        widthOne: 'Eine Karte',
        widthTwo: 'Zwei Karten',
        moveEarlier: 'Nach vorn',
        moveLater: 'Nach hinten',
        remove: 'Vom Board entfernen',
        menuA11y: ({ widget }) => `Optionen für ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Gerade ist 1 Widget hinzugekommen' : `Gerade sind ${count} Widgets hinzugekommen`),
        undo: 'Rückgängig',
        dismiss: 'Schließen',
    },
    saveFailed: {
        tooLarge: 'Dieses Board überschreitet das Speicherlimit für Boards. Entferne einige Elemente und versuche es erneut.',
        notFound: 'Dieses Board wurde auf einem anderen Gerät gelöscht.',
        generic: 'Deine Änderung hat dein Konto nicht erreicht, das Board ist daher unverändert.',
        retry: 'Erneut versuchen',
        dismiss: 'Schließen',
        createTitle: 'Dieses Board wurde nicht erstellt',
    },
};

const es: BoardsTranslations = {
    title: 'Tableros',
    newBoard: 'Tablero nuevo',
    defaultName: 'Tablero sin nombre',
    index: {
        title: 'Tus tableros',
        body: 'Un tablero mantiene sesiones, ejecuciones, flujos de trabajo y máquinas en vivo en un solo lugar, organizados a tu manera.',
    },
    notFound: {
        title: 'Este tablero ya no existe',
        body: 'Se eliminó, o pertenece a una Home que no está conectada aquí.',
    },
    meta: {
        needYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
        items: ({ count }) => (count === 1 ? '1 elemento' : `${count} elementos`),
        handPicked: 'Elegidos a mano',
        empty: 'Vacío',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Te necesita', description: 'Todo lo que te está esperando' },
        running: { title: 'En marcha', description: 'Ejecuciones de flujos de trabajo en curso' },
        my_machines: { title: 'Mis máquinas', description: 'Presencia y qué se ejecuta en cada una' },
        filter: { title: 'Sesiones', description: 'Todas las sesiones activas' },
    },
    header: {
        layoutA11y: 'Diseño del tablero',
        canvas: 'Lienzo',
        byStatus: 'Por estado',
        add: 'Añadir al tablero',
        settings: 'Ajustes del tablero',
    },
    kinds: {
        session: 'Sesión',
        workflow_run: 'Ejecución de flujo de trabajo',
        workflow: 'Flujo de trabajo',
        machine: 'Máquina',
    },
    card: {
        untitled: 'Elemento no disponible',
        unavailable: 'No disponible',
        unavailableBody: 'Su Home no está conectada en este dispositivo. Se queda en el tablero.',
        notLoaded: 'Aún no se ha cargado',
        remove: 'Quitar del tablero',
        moveHint: 'Las teclas de flecha mueven esta tarjeta por la cuadrícula.',
        moved: ({ x, y }) => `Movida a ${x}, ${y}`,
        moveActions: { up: 'Mover arriba', down: 'Mover abajo', left: 'Mover a la izquierda', right: 'Mover a la derecha' },
        machine: {
            online: 'En línea',
            offline: 'Sin conexión',
            running: ({ count }) => (count === 1 ? '1 sesión en marcha' : `${count} sesiones en marcha`),
            needYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
            idle: 'Ninguna sesión en marcha',
            offlineBody: 'Sus sesiones esperan a que vuelva.',
        },
        workflow: {
            noRuns: 'Aún no hay ejecuciones',
            lastRun: ({ word, age }) => `Última ejecución ${age} · ${word}`,
            needYou: ({ count }) => `${count} te necesita${count === 1 ? '' : 'n'}`,
        },
        run: {
            waitingForYou: 'Esperando tu revisión',
            started: ({ age }) => `Iniciada ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Se ajusta aquí',
        snapOnceHint: 'Mantén ⇧ para ajustar una vez',
    },
    settings: {
        title: 'Ajustes del tablero',
        name: 'Nombre',
        whatsOn: 'Qué hay en este tablero',
        whichSessions: 'Qué sesiones',
        addedByHand: 'Añadido a mano',
        addedByHandNone: 'Aún nada',
        add: 'Añadir',
        layout: 'Diseño',
        layoutDescription: 'El lienzo conserva tu disposición cuando cambias.',
        snap: 'Ajustar a la cuadrícula',
        pin: 'Mostrar en la lista de sesiones',
        pinDescription: 'Fija este tablero encima de tus sesiones.',
        delete: 'Eliminar tablero',
        deleteConfirmTitle: '¿Eliminar este tablero?',
        deleteConfirmBody: 'Solo se va el tablero. Sus sesiones, ejecuciones, flujos de trabajo y máquinas se quedan como están.',
    },
    add: {
        title: 'Añadir al tablero',
        search: 'Buscar elementos',
        groups: { sessions: 'Sesiones', workflows: 'Flujos de trabajo', runs: 'Ejecuciones de flujos de trabajo', machines: 'Máquinas' },
        onBoard: 'En este tablero',
        addHint: 'Añadir',
        addAndPlaceHint: 'Añadir y colocar',
        empty: 'No hay coincidencias.',
    },
    empty: {
        title: 'Elige qué muestra este tablero',
        body: 'Añade sesiones, flujos de trabajo, ejecuciones o máquinas a mano, o muestra una sección como Te necesita. Tú los organizas; el tablero los mantiene en vivo.',
        action: 'Añadir al tablero',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Abrir la galería',
        galleryHint: 'Todos los widgets, con vista previa en vivo',
        addHint: 'Solo tú ves tus tableros',
        widthOne: 'Una tarjeta',
        widthTwo: 'Dos tarjetas',
        moveEarlier: 'Mover antes',
        moveLater: 'Mover después',
        remove: 'Quitar del tablero',
        menuA11y: ({ widget }) => `Opciones de ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Acaba de llegar 1 widget' : `Acaban de llegar ${count} widgets`),
        undo: 'Deshacer',
        dismiss: 'Descartar',
    },
    saveFailed: {
        tooLarge: 'Este tablero supera el límite de almacenamiento de tableros. Quita algunos elementos e inténtalo de nuevo.',
        notFound: 'Este tablero se eliminó en otro dispositivo.',
        generic: 'Tu cambio no llegó a tu cuenta, así que el tablero sigue como estaba.',
        retry: 'Reintentar',
        dismiss: 'Descartar',
        createTitle: 'Este tablero no se creó',
    },
};

const fr: BoardsTranslations = {
    title: 'Tableaux',
    newBoard: 'Nouveau tableau',
    defaultName: 'Tableau sans titre',
    index: {
        title: 'Vos tableaux',
        body: 'Un tableau garde sessions, exécutions, workflows et machines en direct au même endroit, organisés à votre façon.',
    },
    notFound: {
        title: 'Ce tableau n\'existe plus',
        body: 'Il a été supprimé, ou il appartient à un Home qui n\'est pas connecté ici.',
    },
    meta: {
        needYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
        items: ({ count }) => (count === 1 ? '1 élément' : `${count} éléments`),
        handPicked: 'Choisis à la main',
        empty: 'Vide',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'A besoin de vous', description: 'Tout ce qui vous attend' },
        running: { title: 'En cours', description: 'Exécutions de workflows en cours' },
        my_machines: { title: 'Mes machines', description: 'Présence et ce qui tourne sur chacune' },
        filter: { title: 'Sessions', description: 'Toutes les sessions actives' },
    },
    header: {
        layoutA11y: 'Disposition du tableau',
        canvas: 'Canevas',
        byStatus: 'Par statut',
        add: 'Ajouter au tableau',
        settings: 'Réglages du tableau',
    },
    kinds: {
        session: 'Session',
        workflow_run: 'Exécution de workflow',
        workflow: 'Workflow',
        machine: 'Machine',
    },
    card: {
        untitled: 'Élément indisponible',
        unavailable: 'Indisponible',
        unavailableBody: 'Son Home n\'est pas connecté sur cet appareil. Il reste sur le tableau.',
        notLoaded: 'Pas encore chargé',
        remove: 'Retirer du tableau',
        moveHint: 'Les touches fléchées déplacent cette carte sur la grille.',
        moved: ({ x, y }) => `Déplacée en ${x}, ${y}`,
        moveActions: { up: 'Déplacer vers le haut', down: 'Déplacer vers le bas', left: 'Déplacer vers la gauche', right: 'Déplacer vers la droite' },
        machine: {
            online: 'En ligne',
            offline: 'Hors ligne',
            running: ({ count }) => (count === 1 ? '1 session en cours' : `${count} sessions en cours`),
            needYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
            idle: 'Aucune session en cours',
            offlineBody: 'Ses sessions attendent son retour.',
        },
        workflow: {
            noRuns: 'Aucune exécution pour l\'instant',
            lastRun: ({ word, age }) => `Dernière exécution ${age} · ${word}`,
            needYou: ({ count }) => `${count} a${count === 1 ? '' : 'ont'} besoin de vous`,
        },
        run: {
            waitingForYou: 'Attend votre relecture',
            started: ({ age }) => `Lancée ${age}`,
        },
    },
    canvas: {
        snapsHere: 'S\'aimante ici',
        snapOnceHint: 'Maintenez ⇧ pour aligner une fois',
    },
    settings: {
        title: 'Réglages du tableau',
        name: 'Nom',
        whatsOn: 'Ce que contient ce tableau',
        whichSessions: 'Quelles sessions',
        addedByHand: 'Ajouté à la main',
        addedByHandNone: 'Rien pour l\'instant',
        add: 'Ajouter',
        layout: 'Disposition',
        layoutDescription: 'Le canevas garde votre arrangement quand vous changez.',
        snap: 'Aimanter à la grille',
        pin: 'Afficher dans la liste des sessions',
        pinDescription: 'Épingle ce tableau au-dessus de vos sessions.',
        delete: 'Supprimer le tableau',
        deleteConfirmTitle: 'Supprimer ce tableau ?',
        deleteConfirmBody: 'Seul le tableau disparaît. Ses sessions, exécutions, workflows et machines restent tels quels.',
    },
    add: {
        title: 'Ajouter au tableau',
        search: 'Rechercher des éléments',
        groups: { sessions: 'Sessions', workflows: 'Workflows', runs: 'Exécutions de workflows', machines: 'Machines' },
        onBoard: 'Sur ce tableau',
        addHint: 'Ajouter',
        addAndPlaceHint: 'Ajouter et placer',
        empty: 'Aucun résultat.',
    },
    empty: {
        title: 'Choisissez ce que montre ce tableau',
        body: 'Ajoutez à la main des sessions, workflows, exécutions ou machines, ou affichez une section comme « A besoin de vous ». Vous les arrangez ; le tableau les garde en direct.',
        action: 'Ajouter au tableau',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Ouvrir la galerie',
        galleryHint: 'Tous les widgets, avec un aperçu en direct',
        addHint: 'Vous seul voyez vos tableaux',
        widthOne: 'Une carte',
        widthTwo: 'Deux cartes',
        moveEarlier: 'Avancer',
        moveLater: 'Reculer',
        remove: 'Retirer du tableau',
        menuA11y: ({ widget }) => `Options de ${widget}`,
        arrived: ({ count }) => (count === 1 ? '1 widget vient d’arriver' : `${count} widgets viennent d’arriver`),
        undo: 'Annuler',
        dismiss: 'Ignorer',
    },
    saveFailed: {
        tooLarge: 'Ce tableau dépasse la limite de stockage des tableaux. Retirez quelques éléments, puis réessayez.',
        notFound: 'Ce tableau a été supprimé sur un autre appareil.',
        generic: 'Votre modification n\'a pas atteint votre compte, le tableau est donc inchangé.',
        retry: 'Réessayer',
        dismiss: 'Ignorer',
        createTitle: 'Ce tableau n’a pas été créé',
    },
};

const it: BoardsTranslations = {
    title: 'Bacheche',
    newBoard: 'Nuova bacheca',
    defaultName: 'Bacheca senza nome',
    index: {
        title: 'Le tue bacheche',
        body: 'Una bacheca tiene sessioni, esecuzioni, workflow e macchine in diretta in un unico posto, disposti a modo tuo.',
    },
    notFound: {
        title: 'Questa bacheca non c\'è più',
        body: 'È stata eliminata, oppure appartiene a una Home non connessa qui.',
    },
    meta: {
        needYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
        items: ({ count }) => (count === 1 ? '1 elemento' : `${count} elementi`),
        handPicked: 'Scelti a mano',
        empty: 'Vuota',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Ha bisogno di te', description: 'Tutto ciò che ti aspetta' },
        running: { title: 'In esecuzione', description: 'Esecuzioni di workflow in corso' },
        my_machines: { title: 'Le mie macchine', description: 'Presenza e cosa gira su ciascuna' },
        filter: { title: 'Sessioni', description: 'Tutte le sessioni attive' },
    },
    header: {
        layoutA11y: 'Disposizione della bacheca',
        canvas: 'Canvas',
        byStatus: 'Per stato',
        add: 'Aggiungi alla bacheca',
        settings: 'Impostazioni della bacheca',
    },
    kinds: {
        session: 'Sessione',
        workflow_run: 'Esecuzione di workflow',
        workflow: 'Workflow',
        machine: 'Macchina',
    },
    card: {
        untitled: 'Elemento non disponibile',
        unavailable: 'Non disponibile',
        unavailableBody: 'La sua Home non è connessa su questo dispositivo. Resta sulla bacheca.',
        notLoaded: 'Non ancora caricato',
        remove: 'Rimuovi dalla bacheca',
        moveHint: 'I tasti freccia spostano questa scheda sulla griglia.',
        moved: ({ x, y }) => `Spostata in ${x}, ${y}`,
        moveActions: { up: 'Sposta in su', down: 'Sposta in giù', left: 'Sposta a sinistra', right: 'Sposta a destra' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 sessione in corso' : `${count} sessioni in corso`),
            needYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
            idle: 'Nessuna sessione in corso',
            offlineBody: 'Le sue sessioni aspettano che torni.',
        },
        workflow: {
            noRuns: 'Ancora nessuna esecuzione',
            lastRun: ({ word, age }) => `Ultima esecuzione ${age} · ${word}`,
            needYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
        },
        run: {
            waitingForYou: 'In attesa della tua revisione',
            started: ({ age }) => `Avviata ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Si aggancia qui',
        snapOnceHint: 'Tieni premuto ⇧ per agganciare una volta',
    },
    settings: {
        title: 'Impostazioni della bacheca',
        name: 'Nome',
        whatsOn: 'Cosa c\'è su questa bacheca',
        whichSessions: 'Quali sessioni',
        addedByHand: 'Aggiunti a mano',
        addedByHandNone: 'Ancora niente',
        add: 'Aggiungi',
        layout: 'Disposizione',
        layoutDescription: 'Canvas mantiene la tua disposizione quando cambi.',
        snap: 'Aggancia alla griglia',
        pin: 'Mostra nell\'elenco delle sessioni',
        pinDescription: 'Fissa questa bacheca sopra le tue sessioni.',
        delete: 'Elimina bacheca',
        deleteConfirmTitle: 'Eliminare questa bacheca?',
        deleteConfirmBody: 'Sparisce solo la bacheca. Le sue sessioni, esecuzioni, workflow e macchine restano come sono.',
    },
    add: {
        title: 'Aggiungi alla bacheca',
        search: 'Cerca elementi',
        groups: { sessions: 'Sessioni', workflows: 'Workflow', runs: 'Esecuzioni di workflow', machines: 'Macchine' },
        onBoard: 'Su questa bacheca',
        addHint: 'Aggiungi',
        addAndPlaceHint: 'Aggiungi e posiziona',
        empty: 'Nessun risultato.',
    },
    empty: {
        title: 'Scegli cosa mostra questa bacheca',
        body: 'Aggiungi a mano sessioni, workflow, esecuzioni o macchine, oppure mostra una sezione come Ha bisogno di te. Le disponi tu; la bacheca le tiene in diretta.',
        action: 'Aggiungi alla bacheca',
    },
    widgets: {
        group: 'Widget',
        kind: 'Widget',
        gallery: 'Apri la galleria',
        galleryHint: 'Tutti i widget, con anteprima dal vivo',
        addHint: 'Solo tu vedi le tue bacheche',
        widthOne: 'Una scheda',
        widthTwo: 'Due schede',
        moveEarlier: 'Sposta prima',
        moveLater: 'Sposta dopo',
        remove: 'Rimuovi dalla bacheca',
        menuA11y: ({ widget }) => `Opzioni di ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'È appena arrivato 1 widget' : `Sono appena arrivati ${count} widget`),
        undo: 'Annulla',
        dismiss: 'Ignora',
    },
    saveFailed: {
        tooLarge: 'Questa bacheca supera il limite di archiviazione delle bacheche. Rimuovi qualche elemento e riprova.',
        notFound: 'Questa bacheca è stata eliminata su un altro dispositivo.',
        generic: 'La tua modifica non è arrivata al tuo account, quindi la bacheca è rimasta com\'era.',
        retry: 'Riprova',
        dismiss: 'Chiudi',
        createTitle: 'Questa bacheca non è stata creata',
    },
};

const ja: BoardsTranslations = {
    title: 'ボード',
    newBoard: '新しいボード',
    defaultName: '名称未設定のボード',
    index: {
        title: 'あなたのボード',
        body: 'ボードは、セッション、実行、ワークフロー、マシンをひとつの場所でライブに保ち、好きなように並べられます。',
    },
    notFound: {
        title: 'このボードはありません',
        body: '削除されたか、ここに接続されていない Home のボードです。',
    },
    meta: {
        needYou: ({ count }) => `${count} 件が対応待ち`,
        items: ({ count }) => `${count} 件`,
        handPicked: '手動で選択',
        empty: '空',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: '対応待ち', description: 'あなたを待っているものすべて' },
        running: { title: '実行中', description: '進行中のワークフロー実行' },
        my_machines: { title: '自分のマシン', description: '接続状況と各マシンで動いているもの' },
        filter: { title: 'セッション', description: 'アクティブなセッションすべて' },
    },
    header: {
        layoutA11y: 'ボードのレイアウト',
        canvas: 'キャンバス',
        byStatus: '状態別',
        add: 'ボードに追加',
        settings: 'ボードの設定',
    },
    kinds: {
        session: 'セッション',
        workflow_run: 'ワークフロー実行',
        workflow: 'ワークフロー',
        machine: 'マシン',
    },
    card: {
        untitled: '利用できない項目',
        unavailable: '利用できません',
        unavailableBody: 'この項目の Home はこのデバイスに接続されていません。ボードには残ります。',
        notLoaded: 'まだ読み込まれていません',
        remove: 'ボードから外す',
        moveHint: '矢印キーでこのカードをグリッド上で動かせます。',
        moved: ({ x, y }) => `${x}, ${y} に移動しました`,
        moveActions: { up: '上へ移動', down: '下へ移動', left: '左へ移動', right: '右へ移動' },
        machine: {
            online: 'オンライン',
            offline: 'オフライン',
            running: ({ count }) => `${count} 件のセッションが実行中`,
            needYou: ({ count }) => `${count} 件が対応待ち`,
            idle: '実行中のセッションはありません',
            offlineBody: 'セッションは戻ってくるまで待機します。',
        },
        workflow: {
            noRuns: 'まだ実行がありません',
            lastRun: ({ word, age }) => `前回の実行 ${age} · ${word}`,
            needYou: ({ count }) => `${count} 件が対応待ち`,
        },
        run: {
            waitingForYou: 'レビュー待ち',
            started: ({ age }) => `${age}に開始`,
        },
    },
    canvas: {
        snapsHere: 'ここに吸着します',
        snapOnceHint: '⇧ を押すと一度だけグリッドに合わせます',
    },
    settings: {
        title: 'ボードの設定',
        name: '名前',
        whatsOn: 'このボードの内容',
        whichSessions: '対象のセッション',
        addedByHand: '手動で追加',
        addedByHandNone: 'まだありません',
        add: '追加',
        layout: 'レイアウト',
        layoutDescription: '切り替えても、キャンバスの配置は保たれます。',
        snap: 'グリッドに吸着',
        pin: 'セッション一覧に表示',
        pinDescription: 'このボードをセッションの上に固定します。',
        delete: 'ボードを削除',
        deleteConfirmTitle: 'このボードを削除しますか？',
        deleteConfirmBody: '削除されるのはボードだけです。セッション、実行、ワークフロー、マシンはそのまま残ります。',
    },
    add: {
        title: 'ボードに追加',
        search: '項目を検索',
        groups: { sessions: 'セッション', workflows: 'ワークフロー', runs: 'ワークフロー実行', machines: 'マシン' },
        onBoard: 'このボード上',
        addHint: '追加',
        addAndPlaceHint: '追加して配置',
        empty: '一致するものはありません。',
    },
    empty: {
        title: 'このボードに表示するものを選びましょう',
        body: 'セッション、ワークフロー、実行、マシンを手動で追加するか、「対応待ち」のようなセクションを表示します。配置はあなた次第。ボードがライブに保ちます。',
        action: 'ボードに追加',
    },
    widgets: {
        group: 'ウィジェット',
        kind: 'ウィジェット',
        gallery: 'ギャラリーを開く',
        galleryHint: 'すべてのウィジェットをライブプレビューで',
        addHint: 'ボードはあなただけに表示されます',
        widthOne: 'カード1枚分',
        widthTwo: 'カード2枚分',
        moveEarlier: '前へ移動',
        moveLater: '後ろへ移動',
        remove: 'ボードから削除',
        menuA11y: ({ widget }) => `${widget} のオプション`,
        arrived: ({ count }) => `ウィジェットが${count}件届きました`,
        undo: '元に戻す',
        dismiss: '閉じる',
    },
    saveFailed: {
        tooLarge: 'このボードはボードの保存容量の上限を超えています。いくつか項目を外してから、もう一度お試しください。',
        notFound: 'このボードは別のデバイスで削除されました。',
        generic: '変更がアカウントに届かなかったため、ボードは元のままです。',
        retry: 'もう一度試す',
        dismiss: '閉じる',
        createTitle: 'このボードは作成されませんでした',
    },
};

const pl: BoardsTranslations = {
    title: 'Tablice',
    newBoard: 'Nowa tablica',
    defaultName: 'Tablica bez nazwy',
    index: {
        title: 'Twoje tablice',
        body: 'Tablica trzyma sesje, uruchomienia, przepływy pracy i maszyny na żywo w jednym miejscu, ułożone po Twojemu.',
    },
    notFound: {
        title: 'Tej tablicy już nie ma',
        body: 'Została usunięta albo należy do Home, który nie jest tu połączony.',
    },
    meta: {
        needYou: ({ count }) => `${count} czeka na Ciebie`,
        items: ({ count }) => `${count} ${slavicPlural(count, 'element', 'elementy', 'elementów')}`,
        handPicked: 'Wybrane ręcznie',
        empty: 'Pusta',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Czeka na Ciebie', description: 'Wszystko, co na Ciebie czeka' },
        running: { title: 'Działa teraz', description: 'Trwające uruchomienia przepływów pracy' },
        my_machines: { title: 'Moje maszyny', description: 'Obecność i to, co działa na każdej' },
        filter: { title: 'Sesje', description: 'Wszystkie aktywne sesje' },
    },
    header: {
        layoutA11y: 'Układ tablicy',
        canvas: 'Kanwa',
        byStatus: 'Wg statusu',
        add: 'Dodaj do tablicy',
        settings: 'Ustawienia tablicy',
    },
    kinds: {
        session: 'Sesja',
        workflow_run: 'Uruchomienie przepływu pracy',
        workflow: 'Przepływ pracy',
        machine: 'Maszyna',
    },
    card: {
        untitled: 'Niedostępny element',
        unavailable: 'Niedostępne',
        unavailableBody: 'Jego Home nie jest połączony na tym urządzeniu. Element zostaje na tablicy.',
        notLoaded: 'Jeszcze nie wczytano',
        remove: 'Usuń z tablicy',
        moveHint: 'Klawisze strzałek przesuwają tę kartę po siatce.',
        moved: ({ x, y }) => `Przesunięto do ${x}, ${y}`,
        moveActions: { up: 'Przesuń w górę', down: 'Przesuń w dół', left: 'Przesuń w lewo', right: 'Przesuń w prawo' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) =>
                count === 1 ? '1 sesja działa' : `${count} ${slavicPlural(count, 'sesja działa', 'sesje działają', 'sesji działa')}`,
            needYou: ({ count }) => `${count} czeka na Ciebie`,
            idle: 'Żadna sesja nie działa',
            offlineBody: 'Jej sesje czekają, aż wróci.',
        },
        workflow: {
            noRuns: 'Brak uruchomień',
            lastRun: ({ word, age }) => `Ostatnie uruchomienie ${age} · ${word}`,
            needYou: ({ count }) => `${count} czeka na Ciebie`,
        },
        run: {
            waitingForYou: 'Czeka na Twoją recenzję',
            started: ({ age }) => `Uruchomiono ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Przyciąga się tutaj',
        snapOnceHint: 'Przytrzymaj ⇧, by raz przyciągnąć do siatki',
    },
    settings: {
        title: 'Ustawienia tablicy',
        name: 'Nazwa',
        whatsOn: 'Co jest na tej tablicy',
        whichSessions: 'Które sesje',
        addedByHand: 'Dodane ręcznie',
        addedByHandNone: 'Jeszcze nic',
        add: 'Dodaj',
        layout: 'Układ',
        layoutDescription: 'Kanwa zachowuje Twój układ po przełączeniu.',
        snap: 'Przyciągaj do siatki',
        pin: 'Pokaż na liście sesji',
        pinDescription: 'Przypina tę tablicę nad Twoimi sesjami.',
        delete: 'Usuń tablicę',
        deleteConfirmTitle: 'Usunąć tę tablicę?',
        deleteConfirmBody: 'Znika tylko tablica. Jej sesje, uruchomienia, przepływy pracy i maszyny zostają bez zmian.',
    },
    add: {
        title: 'Dodaj do tablicy',
        search: 'Szukaj elementów',
        groups: { sessions: 'Sesje', workflows: 'Przepływy pracy', runs: 'Uruchomienia przepływów pracy', machines: 'Maszyny' },
        onBoard: 'Na tej tablicy',
        addHint: 'Dodaj',
        addAndPlaceHint: 'Dodaj i umieść',
        empty: 'Nic nie pasuje.',
    },
    empty: {
        title: 'Wybierz, co pokazuje ta tablica',
        body: 'Dodaj ręcznie sesje, przepływy pracy, uruchomienia lub maszyny albo pokaż sekcję, np. Czeka na Ciebie. Ty je układasz; tablica trzyma je na żywo.',
        action: 'Dodaj do tablicy',
    },
    widgets: {
        group: 'Widżety',
        kind: 'Widżet',
        gallery: 'Otwórz galerię',
        galleryHint: 'Wszystkie widżety z podglądem na żywo',
        addHint: 'Tylko ty widzisz swoje tablice',
        widthOne: 'Jedna karta',
        widthTwo: 'Dwie karty',
        moveEarlier: 'Przesuń wcześniej',
        moveLater: 'Przesuń później',
        remove: 'Usuń z tablicy',
        menuA11y: ({ widget }) => `Opcje: ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Właśnie dodano 1 widżet' : `Właśnie dodano ${count} ${slavicPlural(count, 'widżet', 'widżety', 'widżetów')}`),
        undo: 'Cofnij',
        dismiss: 'Odrzuć',
    },
    saveFailed: {
        tooLarge: 'Ta tablica przekracza limit przechowywania tablic. Usuń kilka elementów i spróbuj ponownie.',
        notFound: 'Ta tablica została usunięta na innym urządzeniu.',
        generic: 'Twoja zmiana nie dotarła do konta, więc tablica została bez zmian.',
        retry: 'Spróbuj ponownie',
        dismiss: 'Odrzuć',
        createTitle: 'Ta tablica nie została utworzona',
    },
};

const pt: BoardsTranslations = {
    title: 'Quadros',
    newBoard: 'Novo quadro',
    defaultName: 'Quadro sem nome',
    index: {
        title: 'Seus quadros',
        body: 'Um quadro mantém sessões, execuções, fluxos de trabalho e máquinas ao vivo em um só lugar, organizados do seu jeito.',
    },
    notFound: {
        title: 'Este quadro não existe mais',
        body: 'Ele foi excluído ou pertence a uma Home que não está conectada aqui.',
    },
    meta: {
        needYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
        items: ({ count }) => (count === 1 ? '1 item' : `${count} itens`),
        handPicked: 'Escolhidos à mão',
        empty: 'Vazio',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Precisa de você', description: 'Tudo o que está esperando por você' },
        running: { title: 'Em execução agora', description: 'Execuções de fluxos de trabalho em andamento' },
        my_machines: { title: 'Minhas máquinas', description: 'Presença e o que roda em cada uma' },
        filter: { title: 'Sessões', description: 'Todas as sessões ativas' },
    },
    header: {
        layoutA11y: 'Layout do quadro',
        canvas: 'Tela',
        byStatus: 'Por status',
        add: 'Adicionar ao quadro',
        settings: 'Configurações do quadro',
    },
    kinds: {
        session: 'Sessão',
        workflow_run: 'Execução de fluxo de trabalho',
        workflow: 'Fluxo de trabalho',
        machine: 'Máquina',
    },
    card: {
        untitled: 'Item indisponível',
        unavailable: 'Indisponível',
        unavailableBody: 'A Home dele não está conectada neste dispositivo. Ele continua no quadro.',
        notLoaded: 'Ainda não carregado',
        remove: 'Remover do quadro',
        moveHint: 'As teclas de seta movem este cartão na grade.',
        moved: ({ x, y }) => `Movido para ${x}, ${y}`,
        moveActions: { up: 'Mover para cima', down: 'Mover para baixo', left: 'Mover para a esquerda', right: 'Mover para a direita' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 sessão em execução' : `${count} sessões em execução`),
            needYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
            idle: 'Nenhuma sessão em execução',
            offlineBody: 'As sessões esperam até ela voltar.',
        },
        workflow: {
            noRuns: 'Nenhuma execução ainda',
            lastRun: ({ word, age }) => `Última execução ${age} · ${word}`,
            needYou: ({ count }) => `${count} precisa${count === 1 ? '' : 'm'} de você`,
        },
        run: {
            waitingForYou: 'Aguardando sua revisão',
            started: ({ age }) => `Iniciada ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Encaixa aqui',
        snapOnceHint: 'Segure ⇧ para encaixar uma vez',
    },
    settings: {
        title: 'Configurações do quadro',
        name: 'Nome',
        whatsOn: 'O que há neste quadro',
        whichSessions: 'Quais sessões',
        addedByHand: 'Adicionados à mão',
        addedByHandNone: 'Nada ainda',
        add: 'Adicionar',
        layout: 'Layout',
        layoutDescription: 'A tela mantém sua organização quando você alterna.',
        snap: 'Alinhar à grade',
        pin: 'Mostrar na lista de sessões',
        pinDescription: 'Fixa este quadro acima das suas sessões.',
        delete: 'Excluir quadro',
        deleteConfirmTitle: 'Excluir este quadro?',
        deleteConfirmBody: 'Só o quadro some. Suas sessões, execuções, fluxos de trabalho e máquinas continuam como estão.',
    },
    add: {
        title: 'Adicionar ao quadro',
        search: 'Buscar itens',
        groups: { sessions: 'Sessões', workflows: 'Fluxos de trabalho', runs: 'Execuções de fluxos de trabalho', machines: 'Máquinas' },
        onBoard: 'Neste quadro',
        addHint: 'Adicionar',
        addAndPlaceHint: 'Adicionar e posicionar',
        empty: 'Nada encontrado.',
    },
    empty: {
        title: 'Escolha o que este quadro mostra',
        body: 'Adicione sessões, fluxos de trabalho, execuções ou máquinas à mão, ou mostre uma seção como Precisa de você. Você organiza; o quadro os mantém ao vivo.',
        action: 'Adicionar ao quadro',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Abrir a galeria',
        galleryHint: 'Todos os widgets, com prévia ao vivo',
        addHint: 'Só você vê seus quadros',
        widthOne: 'Um cartão',
        widthTwo: 'Dois cartões',
        moveEarlier: 'Mover para antes',
        moveLater: 'Mover para depois',
        remove: 'Remover do quadro',
        menuA11y: ({ widget }) => `Opções de ${widget}`,
        arrived: ({ count }) => (count === 1 ? '1 widget acabou de chegar' : `${count} widgets acabaram de chegar`),
        undo: 'Desfazer',
        dismiss: 'Dispensar',
    },
    saveFailed: {
        tooLarge: 'Este quadro ultrapassa o limite de armazenamento dos quadros. Remova alguns itens e tente de novo.',
        notFound: 'Este quadro foi excluído em outro dispositivo.',
        generic: 'Sua alteração não chegou à sua conta, então o quadro continua como estava.',
        retry: 'Tentar de novo',
        dismiss: 'Dispensar',
        createTitle: 'Este quadro não foi criado',
    },
};

const ru: BoardsTranslations = {
    title: 'Доски',
    newBoard: 'Новая доска',
    defaultName: 'Доска без названия',
    index: {
        title: 'Ваши доски',
        body: 'Доска держит сессии, запуски, воркфлоу и машины в живом виде в одном месте, расположенные так, как удобно вам.',
    },
    notFound: {
        title: 'Этой доски больше нет',
        body: 'Её удалили, или она принадлежит Home, который здесь не подключён.',
    },
    meta: {
        needYou: ({ count }) => `Ждут вас: ${count}`,
        items: ({ count }) => `${count} ${slavicPlural(count, 'элемент', 'элемента', 'элементов')}`,
        handPicked: 'Выбрано вручную',
        empty: 'Пусто',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Ждут вас', description: 'Всё, что ждёт вас' },
        running: { title: 'Выполняется сейчас', description: 'Запуски воркфлоу в процессе' },
        my_machines: { title: 'Мои машины', description: 'Доступность и что запущено на каждой' },
        filter: { title: 'Сессии', description: 'Все активные сессии' },
    },
    header: {
        layoutA11y: 'Вид доски',
        canvas: 'Холст',
        byStatus: 'По статусу',
        add: 'Добавить на доску',
        settings: 'Настройки доски',
    },
    kinds: {
        session: 'Сессия',
        workflow_run: 'Запуск воркфлоу',
        workflow: 'Воркфлоу',
        machine: 'Машина',
    },
    card: {
        untitled: 'Недоступный элемент',
        unavailable: 'Недоступно',
        unavailableBody: 'Его Home не подключён на этом устройстве. Элемент остаётся на доске.',
        notLoaded: 'Ещё не загружено',
        remove: 'Убрать с доски',
        moveHint: 'Стрелки перемещают эту карточку по сетке.',
        moved: ({ x, y }) => `Перемещено в ${x}, ${y}`,
        moveActions: { up: 'Переместить вверх', down: 'Переместить вниз', left: 'Переместить влево', right: 'Переместить вправо' },
        machine: {
            online: 'В сети',
            offline: 'Не в сети',
            running: ({ count }) => `${slavicPlural(count, 'Выполняется', 'Выполняются', 'Выполняется')} ${count} ${slavicPlural(count, 'сессия', 'сессии', 'сессий')}`,
            needYou: ({ count }) => `Ждут вас: ${count}`,
            idle: 'Нет запущенных сессий',
            offlineBody: 'Её сессии подождут, пока она вернётся.',
        },
        workflow: {
            noRuns: 'Запусков пока нет',
            lastRun: ({ word, age }) => `Последний запуск ${age} · ${word}`,
            needYou: ({ count }) => `Ждут вас: ${count}`,
        },
        run: {
            waitingForYou: 'Ждёт вашей проверки',
            started: ({ age }) => `Запущен ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Привязывается сюда',
        snapOnceHint: 'Удерживайте ⇧, чтобы один раз привязать к сетке',
    },
    settings: {
        title: 'Настройки доски',
        name: 'Название',
        whatsOn: 'Что на этой доске',
        whichSessions: 'Какие сессии',
        addedByHand: 'Добавлено вручную',
        addedByHandNone: 'Пока ничего',
        add: 'Добавить',
        layout: 'Вид',
        layoutDescription: 'Холст сохраняет вашу расстановку при переключении.',
        snap: 'Привязка к сетке',
        pin: 'Показывать в списке сессий',
        pinDescription: 'Закрепляет эту доску над вашими сессиями.',
        delete: 'Удалить доску',
        deleteConfirmTitle: 'Удалить эту доску?',
        deleteConfirmBody: 'Исчезнет только доска. Её сессии, запуски, воркфлоу и машины останутся как есть.',
    },
    add: {
        title: 'Добавить на доску',
        search: 'Искать элементы',
        groups: { sessions: 'Сессии', workflows: 'Воркфлоу', runs: 'Запуски воркфлоу', machines: 'Машины' },
        onBoard: 'На этой доске',
        addHint: 'Добавить',
        addAndPlaceHint: 'Добавить и разместить',
        empty: 'Ничего не найдено.',
    },
    empty: {
        title: 'Выберите, что покажет эта доска',
        body: 'Добавьте сессии, воркфлоу, запуски или машины вручную либо покажите раздел, например «Ждут вас». Вы их расставляете, а доска держит их в живом виде.',
        action: 'Добавить на доску',
    },
    widgets: {
        group: 'Виджеты',
        kind: 'Виджет',
        gallery: 'Открыть галерею',
        galleryHint: 'Все виджеты с живым предпросмотром',
        addHint: 'Ваши доски видите только вы',
        widthOne: 'Одна карточка',
        widthTwo: 'Две карточки',
        moveEarlier: 'Переместить раньше',
        moveLater: 'Переместить позже',
        remove: 'Убрать с доски',
        menuA11y: ({ widget }) => `Параметры: ${widget}`,
        arrived: ({ count }) => `Только что добавлено: ${count} ${slavicPlural(count, 'виджет', 'виджета', 'виджетов')}`,
        undo: 'Отменить',
        dismiss: 'Скрыть',
    },
    saveFailed: {
        tooLarge: 'Эта доска превышает лимит хранилища досок. Уберите несколько элементов и попробуйте снова.',
        notFound: 'Эта доска была удалена на другом устройстве.',
        generic: 'Ваше изменение не дошло до аккаунта, поэтому доска осталась прежней.',
        retry: 'Повторить',
        dismiss: 'Закрыть',
        createTitle: 'Эта доска не создана',
    },
};

const zhHans: BoardsTranslations = {
    title: '面板',
    newBoard: '新面板',
    defaultName: '未命名面板',
    index: {
        title: '你的面板',
        body: '面板把会话、运行、工作流和设备实时汇聚在一处，按你的方式排布。',
    },
    notFound: {
        title: '这个面板已不存在',
        body: '它已被删除，或属于此处未连接的 Home。',
    },
    meta: {
        needYou: ({ count }) => `${count} 项需要你`,
        items: ({ count }) => `${count} 项`,
        handPicked: '手动挑选',
        empty: '空',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: '需要你', description: '所有在等你处理的事项' },
        running: { title: '正在运行', description: '进行中的工作流运行' },
        my_machines: { title: '我的设备', description: '在线状态以及每台设备上运行的内容' },
        filter: { title: '会话', description: '所有活跃会话' },
    },
    header: {
        layoutA11y: '面板布局',
        canvas: '画布',
        byStatus: '按状态',
        add: '添加到面板',
        settings: '面板设置',
    },
    kinds: {
        session: '会话',
        workflow_run: '工作流运行',
        workflow: '工作流',
        machine: '设备',
    },
    card: {
        untitled: '不可用的项目',
        unavailable: '不可用',
        unavailableBody: '它的 Home 未在此设备上连接。它会保留在面板上。',
        notLoaded: '尚未加载',
        remove: '从面板移除',
        moveHint: '方向键可在网格上移动此卡片。',
        moved: ({ x, y }) => `已移动到 ${x}, ${y}`,
        moveActions: { up: '上移', down: '下移', left: '左移', right: '右移' },
        machine: {
            online: '在线',
            offline: '离线',
            running: ({ count }) => `${count} 个会话正在运行`,
            needYou: ({ count }) => `${count} 项需要你`,
            idle: '没有正在运行的会话',
            offlineBody: '它的会话会等它回来。',
        },
        workflow: {
            noRuns: '还没有运行',
            lastRun: ({ word, age }) => `上次运行 ${age} · ${word}`,
            needYou: ({ count }) => `${count} 项需要你`,
        },
        run: {
            waitingForYou: '等待你的审阅',
            started: ({ age }) => `${age}开始`,
        },
    },
    canvas: {
        snapsHere: '会吸附到这里',
        snapOnceHint: '按住 ⇧ 可单次对齐网格',
    },
    settings: {
        title: '面板设置',
        name: '名称',
        whatsOn: '此面板上有什么',
        whichSessions: '哪些会话',
        addedByHand: '手动添加',
        addedByHandNone: '暂无',
        add: '添加',
        layout: '布局',
        layoutDescription: '切换时，画布会保留你的排布。',
        snap: '吸附到网格',
        pin: '显示在会话列表中',
        pinDescription: '将此面板固定在你的会话上方。',
        delete: '删除面板',
        deleteConfirmTitle: '删除这个面板？',
        deleteConfirmBody: '只会删除面板。其中的会话、运行、工作流和设备都会保持原样。',
    },
    add: {
        title: '添加到面板',
        search: '搜索项目',
        groups: { sessions: '会话', workflows: '工作流', runs: '工作流运行', machines: '设备' },
        onBoard: '在此面板上',
        addHint: '添加',
        addAndPlaceHint: '添加并放置',
        empty: '没有匹配项。',
    },
    empty: {
        title: '选择此面板显示什么',
        body: '手动添加会话、工作流、运行或设备，或显示“需要你”这样的分区。排布由你决定，面板让它们保持实时。',
        action: '添加到面板',
    },
    widgets: {
        group: '小组件',
        kind: '小组件',
        gallery: '打开图库',
        galleryHint: '所有小组件，附实时预览',
        addHint: '面板仅你可见',
        widthOne: '一张卡片宽',
        widthTwo: '两张卡片宽',
        moveEarlier: '前移',
        moveLater: '后移',
        remove: '从面板移除',
        menuA11y: ({ widget }) => `${widget} 选项`,
        arrived: ({ count }) => `刚刚添加了 ${count} 个小组件`,
        undo: '撤销',
        dismiss: '忽略',
    },
    saveFailed: {
        tooLarge: '这个面板超出了面板存储空间的限制。请移除一些项目后重试。',
        notFound: '这个面板已在另一台设备上被删除。',
        generic: '你的更改没有同步到账户，面板保持原样。',
        retry: '重试',
        dismiss: '忽略',
        createTitle: '这个面板未创建',
    },
};

const zhHant: BoardsTranslations = {
    title: '面板',
    newBoard: '新面板',
    defaultName: '未命名面板',
    index: {
        title: '你的面板',
        body: '面板把工作階段、執行、工作流程和裝置即時匯聚在同一處，依你的方式排列。',
    },
    notFound: {
        title: '這個面板已不存在',
        body: '它已被刪除，或屬於此處未連線的 Home。',
    },
    meta: {
        needYou: ({ count }) => `${count} 項需要你`,
        items: ({ count }) => `${count} 項`,
        handPicked: '手動挑選',
        empty: '空',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: '需要你', description: '所有在等你處理的事項' },
        running: { title: '正在執行', description: '進行中的工作流程執行' },
        my_machines: { title: '我的裝置', description: '連線狀態以及每台裝置上執行的內容' },
        filter: { title: '工作階段', description: '所有使用中的工作階段' },
    },
    header: {
        layoutA11y: '面板版面',
        canvas: '畫布',
        byStatus: '依狀態',
        add: '加入面板',
        settings: '面板設定',
    },
    kinds: {
        session: '工作階段',
        workflow_run: '工作流程執行',
        workflow: '工作流程',
        machine: '裝置',
    },
    card: {
        untitled: '無法使用的項目',
        unavailable: '無法使用',
        unavailableBody: '它的 Home 未在此裝置上連線。它會保留在面板上。',
        notLoaded: '尚未載入',
        remove: '從面板移除',
        moveHint: '方向鍵可在格線上移動此卡片。',
        moved: ({ x, y }) => `已移動到 ${x}, ${y}`,
        moveActions: { up: '上移', down: '下移', left: '左移', right: '右移' },
        machine: {
            online: '線上',
            offline: '離線',
            running: ({ count }) => `${count} 個工作階段正在執行`,
            needYou: ({ count }) => `${count} 項需要你`,
            idle: '沒有正在執行的工作階段',
            offlineBody: '它的工作階段會等它回來。',
        },
        workflow: {
            noRuns: '還沒有執行紀錄',
            lastRun: ({ word, age }) => `上次執行 ${age} · ${word}`,
            needYou: ({ count }) => `${count} 項需要你`,
        },
        run: {
            waitingForYou: '等待你的審閱',
            started: ({ age }) => `${age}開始`,
        },
    },
    canvas: {
        snapsHere: '會吸附到這裡',
        snapOnceHint: '按住 ⇧ 可單次對齊格線',
    },
    settings: {
        title: '面板設定',
        name: '名稱',
        whatsOn: '此面板上有什麼',
        whichSessions: '哪些工作階段',
        addedByHand: '手動加入',
        addedByHandNone: '尚無',
        add: '加入',
        layout: '版面',
        layoutDescription: '切換時，畫布會保留你的排列。',
        snap: '吸附到格線',
        pin: '顯示在工作階段清單中',
        pinDescription: '將此面板固定在你的工作階段上方。',
        delete: '刪除面板',
        deleteConfirmTitle: '刪除這個面板？',
        deleteConfirmBody: '只會刪除面板。其中的工作階段、執行、工作流程和裝置都會維持原樣。',
    },
    add: {
        title: '加入面板',
        search: '搜尋項目',
        groups: { sessions: '工作階段', workflows: '工作流程', runs: '工作流程執行', machines: '裝置' },
        onBoard: '在此面板上',
        addHint: '加入',
        addAndPlaceHint: '新增並放置',
        empty: '沒有符合的項目。',
    },
    empty: {
        title: '選擇此面板顯示什麼',
        body: '手動加入工作階段、工作流程、執行或裝置，或顯示「需要你」這樣的區段。排列由你決定，面板讓它們保持即時。',
        action: '加入面板',
    },
    widgets: {
        group: '小工具',
        kind: '小工具',
        gallery: '開啟圖庫',
        galleryHint: '所有小工具，附即時預覽',
        addHint: '面板只有你看得到',
        widthOne: '一張卡片寬',
        widthTwo: '兩張卡片寬',
        moveEarlier: '往前移',
        moveLater: '往後移',
        remove: '從面板移除',
        menuA11y: ({ widget }) => `${widget} 選項`,
        arrived: ({ count }) => `剛剛新增了 ${count} 個小工具`,
        undo: '復原',
        dismiss: '忽略',
    },
    saveFailed: {
        tooLarge: '這個面板超出了面板儲存空間的限制。請移除一些項目後重試。',
        notFound: '這個面板已在另一台裝置上被刪除。',
        generic: '你的變更沒有同步到帳號，面板維持原樣。',
        retry: '重試',
        dismiss: '忽略',
        createTitle: '這個面板未建立',
    },
};

export const boardsTranslations = {
    en,
    ca,
    de,
    es,
    fr,
    it,
    ja,
    pl,
    pt,
    ru,
    zhHans,
    zhHant,
};
