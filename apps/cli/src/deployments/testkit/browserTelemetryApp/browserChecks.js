function throwCheckoutError() {
    throw new TypeError('F18 fixture browser checkout failed');
}

function rejectCheckoutPromise() {
    void Promise.reject(new Error('F18 fixture browser checkout rejected'));
}

document.querySelector('#throw').addEventListener('click', throwCheckoutError);
document.querySelector('#reject').addEventListener('click', rejectCheckoutPromise);
