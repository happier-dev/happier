import { mcpSignInTranslations } from './mcpSignInTranslations';

type CallbackCopy = Omit<(typeof mcpSignInTranslations)['en']['callback'], 'openServers'> & Readonly<{ openConnections: string }>;
type Overrides = Pick<CallbackCopy, 'connectedBody' | 'pasteBody' | 'invalidBody' | 'unfinishedBody' | 'openConnections'>;
type Locale = keyof typeof mcpSignInTranslations;

function callbackCopy(locale: Locale, overrides: Overrides): CallbackCopy {
    return { ...mcpSignInTranslations[locale].callback, ...overrides };
}

/** Same callback slots as MCP, with connection-screen recovery for generic accounts. */
export const connectedAccountCallbackTranslations = {
    en: callbackCopy('en', {
        connectedBody: 'Taking you back to your connected accounts…',
        pasteBody: 'Paste it on the connection screen where you started signing in. It only works there, once.',
        invalidBody: 'Start signing in again from the connection screen.',
        unfinishedBody: 'Return to the connection screen to continue signing in, or paste this callback there.',
        openConnections: 'Open connected accounts',
    }),
    ca: callbackCopy('ca', {
        connectedBody: 'Tornant als teus comptes connectats…',
        pasteBody: 'Enganxa’l a la pantalla de connexió on has començat a iniciar la sessió. Només funciona allà, una vegada.',
        invalidBody: 'Torna a iniciar la sessió des de la pantalla de connexió.',
        unfinishedBody: 'Torna a la pantalla de connexió per continuar iniciant la sessió o enganxa-hi aquest retorn.',
        openConnections: 'Obre els comptes connectats',
    }),
    de: callbackCopy('de', {
        connectedBody: 'Zurück zu deinen verbundenen Konten…',
        pasteBody: 'Füge ihn auf der Verbindungsseite ein, auf der du die Anmeldung gestartet hast. Er funktioniert nur dort, einmal.',
        invalidBody: 'Starte die Anmeldung erneut auf der Verbindungsseite.',
        unfinishedBody: 'Kehre zur Verbindungsseite zurück, um die Anmeldung fortzusetzen, oder füge dort diese Rückgabe ein.',
        openConnections: 'Verbundene Konten öffnen',
    }),
    es: callbackCopy('es', {
        connectedBody: 'Volviendo a tus cuentas conectadas…',
        pasteBody: 'Pégalo en la pantalla de conexión donde empezaste a iniciar sesión. Solo funciona allí, una vez.',
        invalidBody: 'Vuelve a iniciar sesión desde la pantalla de conexión.',
        unfinishedBody: 'Vuelve a la pantalla de conexión para continuar iniciando sesión o pega allí esta respuesta.',
        openConnections: 'Abrir cuentas conectadas',
    }),
    fr: callbackCopy('fr', {
        connectedBody: 'Retour à vos comptes connectés…',
        pasteBody: 'Collez-le sur l’écran de connexion où vous avez commencé. Il ne fonctionne qu’à cet endroit, une seule fois.',
        invalidBody: 'Recommencez depuis l’écran de connexion.',
        unfinishedBody: 'Revenez à l’écran de connexion pour continuer ou collez-y cette réponse.',
        openConnections: 'Ouvrir les comptes connectés',
    }),
    it: callbackCopy('it', {
        connectedBody: 'Ritorno ai tuoi account collegati…',
        pasteBody: 'Incollalo nella schermata di collegamento in cui hai iniziato l’accesso. Funziona solo lì, una volta.',
        invalidBody: 'Ricomincia l’accesso dalla schermata di collegamento.',
        unfinishedBody: 'Torna alla schermata di collegamento per continuare l’accesso o incolla lì questa risposta.',
        openConnections: 'Apri gli account collegati',
    }),
    ja: callbackCopy('ja', {
        connectedBody: '接続済みアカウントに戻っています…',
        pasteBody: 'サインインを開始した接続画面に貼り付けてください。その画面で一度だけ使用できます。',
        invalidBody: '接続画面からサインインをやり直してください。',
        unfinishedBody: '接続画面に戻ってサインインを続けるか、この応答を貼り付けてください。',
        openConnections: '接続済みアカウントを開く',
    }),
    pl: callbackCopy('pl', {
        connectedBody: 'Powrót do połączonych kont…',
        pasteBody: 'Wklej go na ekranie połączenia, na którym rozpoczęto logowanie. Działa tylko tam, jeden raz.',
        invalidBody: 'Rozpocznij logowanie ponownie na ekranie połączenia.',
        unfinishedBody: 'Wróć do ekranu połączenia, aby kontynuować logowanie, lub wklej tam tę odpowiedź.',
        openConnections: 'Otwórz połączone konta',
    }),
    pt: callbackCopy('pt', {
        connectedBody: 'A voltar às suas contas ligadas…',
        pasteBody: 'Cole-o no ecrã de ligação onde iniciou a sessão. Só funciona ali, uma vez.',
        invalidBody: 'Inicie a sessão novamente a partir do ecrã de ligação.',
        unfinishedBody: 'Volte ao ecrã de ligação para continuar a iniciar a sessão ou cole esta resposta ali.',
        openConnections: 'Abrir contas ligadas',
    }),
    ru: callbackCopy('ru', {
        connectedBody: 'Возвращаемся к подключённым аккаунтам…',
        pasteBody: 'Вставьте его на экране подключения, где вы начали вход. Он работает только там и только один раз.',
        invalidBody: 'Начните вход заново на экране подключения.',
        unfinishedBody: 'Вернитесь на экран подключения, чтобы продолжить вход, или вставьте там этот ответ.',
        openConnections: 'Открыть подключённые аккаунты',
    }),
    zhHans: callbackCopy('zhHans', {
        connectedBody: '正在返回已连接的账户…',
        pasteBody: '请粘贴到开始登录的连接页面。只能在那里使用一次。',
        invalidBody: '请从连接页面重新开始登录。',
        unfinishedBody: '返回连接页面继续登录，或在那里粘贴此回调。',
        openConnections: '打开已连接的账户',
    }),
    zhHant: callbackCopy('zhHant', {
        connectedBody: '正在返回已連接的帳戶…',
        pasteBody: '請貼到開始登入的連接頁面。只能在那裡使用一次。',
        invalidBody: '請從連接頁面重新開始登入。',
        unfinishedBody: '返回連接頁面繼續登入，或在那裡貼上此回呼。',
        openConnections: '開啟已連接的帳戶',
    }),
} satisfies Record<Locale, CallbackCopy>;
