type Count = { count: number };

const en = {
    nextWithCount: ({ count }: Count) => `${count} ${count === 1 ? 'needs' : 'need'} you`,
    next: 'Next', answeredElsewhere: 'Already answered',
    unavailableTitle: 'Couldn’t open the next request',
    unavailableBody: 'Some waiting sessions are unavailable. Reconnect and try again.',
    skippedUnavailable: ({ count }: Count) => `${count} unavailable ${count === 1 ? 'session was' : 'sessions were'} skipped.`,
    waitsForPermission: 'wants your permission',
    waitsForInput: 'is waiting for your answer',
    sessionsWaiting: ({ count }: Count) => `${count} sessions are waiting`,
    go: 'Go',
    dismiss: 'Not now',
};

const ca: typeof en = {
    nextWithCount: ({ count }) => `${count} et necessiten`,
    next: 'Següent', answeredElsewhere: 'Ja s’ha respost',
    unavailableTitle: 'No s’ha pogut obrir la sol·licitud següent',
    unavailableBody: 'Algunes sessions pendents no estan disponibles. Torna a connectar-te i prova-ho de nou.',
    skippedUnavailable: ({ count }) => `S’han omès ${count} sessions no disponibles.`,
    waitsForPermission: 'demana el teu permís', waitsForInput: 'espera la teva resposta',
    sessionsWaiting: ({ count }) => `${count} sessions esperen`, go: 'Ves-hi', dismiss: 'Ara no',
};
const de: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'braucht' : 'brauchen'} dich`,
    next: 'Weiter', answeredElsewhere: 'Bereits beantwortet',
    unavailableTitle: 'Die nächste Anfrage konnte nicht geöffnet werden',
    unavailableBody: 'Einige wartende Sitzungen sind nicht verfügbar. Verbinde dich erneut und versuche es noch einmal.',
    skippedUnavailable: ({ count }) => `${count} nicht verfügbare Sitzungen wurden übersprungen.`,
    waitsForPermission: 'braucht deine Erlaubnis', waitsForInput: 'wartet auf deine Antwort',
    sessionsWaiting: ({ count }) => `${count} Sitzungen warten`, go: 'Los', dismiss: 'Nicht jetzt',
};
const es: typeof en = {
    nextWithCount: ({ count }) => `${count} te ${count === 1 ? 'necesita' : 'necesitan'}`,
    next: 'Siguiente', answeredElsewhere: 'Ya se respondió',
    unavailableTitle: 'No se pudo abrir la siguiente solicitud',
    unavailableBody: 'Algunas sesiones pendientes no están disponibles. Vuelve a conectarte e inténtalo de nuevo.',
    skippedUnavailable: ({ count }) => `Se omitieron ${count} sesiones no disponibles.`,
    waitsForPermission: 'pide tu permiso', waitsForInput: 'espera tu respuesta',
    sessionsWaiting: ({ count }) => `${count} sesiones esperan`, go: 'Ir', dismiss: 'Ahora no',
};
const fr: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'a' : 'ont'} besoin de vous`,
    next: 'Suivant', answeredElsewhere: 'Déjà répondu',
    unavailableTitle: 'Impossible d’ouvrir la demande suivante',
    unavailableBody: 'Certaines sessions en attente sont indisponibles. Reconnectez-vous et réessayez.',
    skippedUnavailable: ({ count }) => `${count} sessions indisponibles ont été ignorées.`,
    waitsForPermission: 'demande votre autorisation', waitsForInput: 'attend votre réponse',
    sessionsWaiting: ({ count }) => `${count} sessions attendent`, go: 'Aller', dismiss: 'Plus tard',
};
const it: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'ha' : 'hanno'} bisogno di te`,
    next: 'Avanti', answeredElsewhere: 'Già risposto',
    unavailableTitle: 'Impossibile aprire la prossima richiesta',
    unavailableBody: 'Alcune sessioni in attesa non sono disponibili. Riconnettiti e riprova.',
    skippedUnavailable: ({ count }) => `${count} sessioni non disponibili sono state saltate.`,
    waitsForPermission: 'chiede il tuo permesso', waitsForInput: 'aspetta la tua risposta',
    sessionsWaiting: ({ count }) => `${count} sessioni in attesa`, go: 'Vai', dismiss: 'Non ora',
};
const ja: typeof en = {
    nextWithCount: ({ count }) => `${count}件が応答を待っています`,
    next: '次へ', answeredElsewhere: '回答済みです',
    unavailableTitle: '次のリクエストを開けませんでした',
    unavailableBody: '応答待ちのセッションの一部を利用できません。再接続してもう一度お試しください。',
    skippedUnavailable: ({ count }) => `利用できないセッション${count}件をスキップしました。`,
    waitsForPermission: 'が許可を求めています', waitsForInput: 'が回答を待っています',
    sessionsWaiting: ({ count }) => `${count}件のセッションが待っています`, go: '移動', dismiss: '後で',
};
const pl: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'czeka' : 'czekają'} na Ciebie`,
    next: 'Dalej', answeredElsewhere: 'Już odpowiedziano',
    unavailableTitle: 'Nie udało się otworzyć następnej prośby',
    unavailableBody: 'Niektóre oczekujące sesje są niedostępne. Połącz się ponownie i spróbuj jeszcze raz.',
    skippedUnavailable: ({ count }) => `Pominięto niedostępne sesje: ${count}.`,
    waitsForPermission: 'prosi o Twoją zgodę', waitsForInput: 'czeka na Twoją odpowiedź',
    sessionsWaiting: ({ count }) => `Czekające sesje: ${count}`, go: 'Przejdź', dismiss: 'Nie teraz',
};
const pt: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'precisa' : 'precisam'} de você`,
    next: 'Próxima', answeredElsewhere: 'Já respondida',
    unavailableTitle: 'Não foi possível abrir a próxima solicitação',
    unavailableBody: 'Algumas sessões em espera estão indisponíveis. Reconecte e tente novamente.',
    skippedUnavailable: ({ count }) => `${count} sessões indisponíveis foram ignoradas.`,
    waitsForPermission: 'pede sua permissão', waitsForInput: 'aguarda sua resposta',
    sessionsWaiting: ({ count }) => `${count} sessões aguardando`, go: 'Ir', dismiss: 'Agora não',
};
const ru: typeof en = {
    nextWithCount: ({ count }) => `Ждут вас: ${count}`,
    next: 'Далее', answeredElsewhere: 'Уже отвечено',
    unavailableTitle: 'Не удалось открыть следующий запрос',
    unavailableBody: 'Некоторые ожидающие сессии недоступны. Подключитесь снова и повторите попытку.',
    skippedUnavailable: ({ count }) => `Пропущено недоступных сессий: ${count}.`,
    waitsForPermission: 'просит разрешения', waitsForInput: 'ждёт вашего ответа',
    sessionsWaiting: ({ count }) => `Ожидающих сессий: ${count}`, go: 'Перейти', dismiss: 'Не сейчас',
};
const zhHans: typeof en = {
    nextWithCount: ({ count }) => `${count} 个会话需要你回应`,
    next: '下一个', answeredElsewhere: '已回应',
    unavailableTitle: '无法打开下一个请求',
    unavailableBody: '部分等待中的会话不可用。请重新连接后再试。',
    skippedUnavailable: ({ count }) => `已跳过 ${count} 个不可用的会话。`,
    waitsForPermission: '请求你的许可', waitsForInput: '在等你回答',
    sessionsWaiting: ({ count }) => `${count} 个会话在等待`, go: '前往', dismiss: '稍后',
};
const zhHant: typeof en = {
    nextWithCount: ({ count }) => `${count} 個工作階段需要你回應`,
    next: '下一個', answeredElsewhere: '已回應',
    unavailableTitle: '無法開啟下一個請求',
    unavailableBody: '部分等待中的工作階段無法使用。請重新連線後再試。',
    skippedUnavailable: ({ count }) => `已略過 ${count} 個無法使用的工作階段。`,
    waitsForPermission: '請求你的許可', waitsForInput: '在等你回答',
    sessionsWaiting: ({ count }) => `${count} 個工作階段在等待`, go: '前往', dismiss: '稍後',
};

export const pendingNavigationTranslations = { en, ca, de, es, fr, it, ja, pl, pt, ru, zhHans, zhHant };
